importScripts("config.js", "lib/supabase.js", "lib/session.js", "lib/lesson-key.js", "lib/recording-backup-db.js", "lib/recording-groups.js");

let recording = false;


// ================================================================
// HEARTBEAT DE PRESENCA (last_seen do usuário logado)
// ================================================================
//
// Enquanto o usuário estiver logado, a extensão atualiza
// profiles.last_seen periodicamente para que a dashboard possa
// mostrar se ele está "online" (usando a extensão agora) ou
// "offline" — mesmo padrão do heartbeat do worker de transcrição.
// ================================================================

const HEARTBEAT_ALARM = "a3os-heartbeat";
const HEARTBEAT_INTERVAL_MINUTES = 0.5; // 30s

async function enviarHeartbeat() {

    try {

        const user = await A3Session.getCurrentUser();

        if (!user) {
            return;
        }

        const token = await A3Session.getValidAccessToken();

        await A3Supabase.restUpdate(
            "profiles",
            `id=eq.${user.id}`,
            { last_seen: new Date().toISOString() },
            token
        );

    } catch (error) {

        console.warn("Erro ao enviar heartbeat:", error);
    }
}

chrome.alarms.create(HEARTBEAT_ALARM, {
    periodInMinutes: HEARTBEAT_INTERVAL_MINUTES
});

chrome.alarms.onAlarm.addListener((alarm) => {

    if (alarm.name === HEARTBEAT_ALARM) {
        enviarHeartbeat();
    }
});

enviarHeartbeat();

let currentRecording = {
    title: "aula",
    outputFolder: ""
};


// ================================================================
// ICONES DA EXTENSAO (normal / gravando)
// ================================================================

const ICON_NORMAL = {

    "16": "icons/icon-normal-16.png",
    "48": "icons/icon-normal-48.png",
    "128": "icons/icon-normal-128.png"
};

const ICON_RECORDING = {

    "16": "icons/icon-recording-16.png",
    "48": "icons/icon-recording-48.png",
    "128": "icons/icon-recording-128.png"
};


// ================================================================
// ESTADO PERSISTENTE (sobrevive a reinícios do service worker)
// ================================================================
//
// O service worker do MV3 pode ser encerrado pelo Chrome a qualquer
// momento em que fica ocioso (uma gravação de vários minutos não o
// mantém vivo sozinha). Quando isso acontece, variáveis como
// `recording`/`currentRecording` voltam ao valor inicial, mas o
// offscreen document (que continua gravando de verdade) não é
// afetado. Por isso o estado é sempre espelhado em
// chrome.storage.session, que sobrevive ao reinício do worker.
// ================================================================

async function salvarEstado(parcial) {

    if (
        Object.prototype.hasOwnProperty.call(
            parcial,
            "recording"
        )
    ) {

        recording = parcial.recording;
    }

    if (
        Object.prototype.hasOwnProperty.call(
            parcial,
            "currentRecording"
        )
    ) {

        currentRecording = parcial.currentRecording;
    }

    await chrome.storage.session.set(parcial);
}

async function carregarEstado() {

    const dados =
        await chrome.storage.session.get(
            ["recording", "currentRecording"]
        );

    recording =
        !!dados.recording;

    currentRecording =
        dados.currentRecording ||
        currentRecording;

    return {
        recording,
        currentRecording
    };
}


// ================================================================
// OFFSCREEN
// ================================================================

async function criarOffscreen() {

    const existe =
        await chrome.offscreen.hasDocument();

    if (existe) {
        return;
    }

    await chrome.offscreen.createDocument({

        url: "offscreen/offscreen.html",

        reasons: [
            "USER_MEDIA"
        ],

        justification:
            "Capturar e gravar o áudio da aba do curso."
    });
}


// ================================================================
// CONSULTAR ESTADO REAL DO OFFSCREEN
// ================================================================
//
// O offscreen document e' quem de fato segura o MediaRecorder/stream,
// entao ele e' a fonte da verdade sobre "esta gravando ou nao" -
// mais confiavel do que uma variavel local do service worker.
// ================================================================

async function consultarOffscreenGravando() {

    const existe =
        await chrome.offscreen.hasDocument();

    if (!existe) {
        return false;
    }

    return new Promise(
        (resolve) => {

            chrome.runtime.sendMessage(

                {
                    target:
                        "offscreen",

                    action:
                        "get-recording-state"
                },

                (response) => {

                    if (chrome.runtime.lastError) {

                        resolve(false);

                        return;
                    }

                    resolve(
                        !!(response && response.recording)
                    );
                }
            );
        }
    );
}


// ================================================================
// INICIAR GRAVAÇÃO
// ================================================================

async function iniciarGravacao(
    title,
    outputFolder,
    moduleName
) {

    try {

        await criarOffscreen();


        // ========================================================
        // JA EXISTE UMA GRAVACAO ATIVA NO OFFSCREEN?
        // (ex.: o service worker foi reiniciado no meio da gravação
        // e "esqueceu" que estava gravando - nao tentar capturar a
        // aba de novo, so' sincronizar o estado)
        // ========================================================

        const jaGravando =
            await consultarOffscreenGravando();

        if (jaGravando) {

            await carregarEstado();

            await salvarEstado({
                recording: true
            });

            chrome.action.setIcon({
                path: ICON_RECORDING
            });

            chrome.runtime.sendMessage({

                action:
                    "recording-state",

                recording:
                    true
            });

            console.log(
                "A3-OS Recorder: gravação já estava em andamento (estado sincronizado)."
            );

            return {
                success: true
            };
        }


        const tabs =
            await chrome.tabs.query({

                active: true,

                currentWindow: true
            });


        const tab =
            tabs[0];


        if (!tab) {

            throw new Error(
                "Nenhuma aba ativa encontrada."
            );
        }


        const lessonKey = A3LessonKey.lessonKey(title, moduleName);
        const sessionId = crypto.randomUUID();

        await salvarEstado({

            currentRecording: {

                title:
                    title ||
                    "aula",

                outputFolder:
                    outputFolder,

                moduleName:
                    moduleName ||
                    null,

                lessonKey:
                    lessonKey,

                sessionId:
                    sessionId
            }
        });


        // ========================================================
        // STREAM ID
        // ========================================================

        const streamId =
            await chrome.tabCapture.getMediaStreamId({

                targetTabId:
                    tab.id
            });


        // ========================================================
        // ENVIAR AO OFFSCREEN
        // ========================================================

        const response =
            await chrome.runtime.sendMessage({

                target:
                    "offscreen",

                action:
                    "start-recording",

                streamId:
                    streamId,

                title:
                    currentRecording.title,

                lessonKey:
                    currentRecording.lessonKey,

                sessionId:
                    currentRecording.sessionId
            });


        if (
            response &&
            response.success === false
        ) {

            throw new Error(
                response.error ||
                "Erro no Offscreen."
            );
        }


        await salvarEstado({
            recording: true
        });


        chrome.action.setIcon({
            path: ICON_RECORDING
        });


        chrome.runtime.sendMessage({

            action:
                "recording-state",

            recording:
                true
        });


        console.log(
            "A3-OS Recorder: gravação iniciada."
        );


        return {
            success: true
        };


    } catch (error) {

        console.error(
            "Erro ao iniciar gravação:",
            error
        );


        await salvarEstado({
            recording: false
        });


        chrome.action.setIcon({
            path: ICON_NORMAL
        });


        return {

            success:
                false,

            error:
                error.message
        };
    }
}


// ================================================================
// PARAR GRAVAÇÃO
// ================================================================

async function pararGravacao() {

    try {

        await chrome.runtime.sendMessage({

            target:
                "offscreen",

            action:
                "stop-recording"
        });


        await salvarEstado({
            recording: false
        });


        chrome.action.setIcon({
            path: ICON_NORMAL
        });


        chrome.runtime.sendMessage({

            action:
                "recording-state",

            recording:
                false
        });


        console.log(
            "A3-OS Recorder: parada solicitada."
        );


        return {
            success: true
        };


    } catch (error) {

        console.error(
            "Erro ao parar gravação:",
            error
        );


        return {

            success:
                false,

            error:
                error.message
        };
    }
}


// ================================================================
// NATIVE HOST
// ================================================================

function selecionarPastaNative() {

    return new Promise(
        (resolve, reject) => {

            let port;

            try {

                port =
                    chrome.runtime.connectNative(
                        "com.a3os.folderpicker.dev"
                    );

            } catch (error) {

                reject(error);

                return;
            }


            let respondeu = false;


            port.onMessage.addListener(
                async (response) => {

                    respondeu = true;


                    console.log(
                        "Native Host:",
                        response
                    );


                    if (
                        response &&
                        response.success &&
                        response.folder
                    ) {

                        await chrome.storage.local.set({

                            outputFolder:
                                response.folder
                        });


                        resolve({

                            success:
                                true,

                            folder:
                                response.folder
                        });

                    } else {

                        resolve({

                            success:
                                false,

                            cancelled:
                                true
                        });
                    }


                    try {
                        port.disconnect();
                    } catch (e) {}
                }
            );


            port.onDisconnect.addListener(
                () => {

                    if (!respondeu) {

                        const error =
                            chrome.runtime.lastError;

                        reject(
                            new Error(
                                error?.message ||
                                "Native Host desconectado."
                            )
                        );
                    }
                }
            );


            port.postMessage({

                action:
                    "select-folder"
            });
        }
    );
}


// ================================================================
// SALVAR ÁUDIO PELO NATIVE HOST
// ================================================================

function salvarAudioNative(
    folder,
    filename,
    chunks
) {

    return new Promise(
        (resolve, reject) => {

            let port;

            try {

                port =
                    chrome.runtime.connectNative(
                        "com.a3os.folderpicker.dev"
                    );

            } catch (error) {

                reject(error);

                return;
            }


            let respondeu = false;


            port.onMessage.addListener(
                (response) => {

                    respondeu = true;


                    console.log(
                        "Native Host salvar:",
                        response
                    );


                    if (
                        response &&
                        response.success
                    ) {

                        resolve(response);

                    } else {

                        reject(
                            new Error(
                                response?.error ||
                                "Native Host não conseguiu salvar o áudio."
                            )
                        );
                    }


                    try {
                        port.disconnect();
                    } catch (e) {}
                }
            );


            port.onDisconnect.addListener(
                () => {

                    if (!respondeu) {

                        const error =
                            chrome.runtime.lastError;

                        reject(
                            new Error(
                                error?.message ||
                                "Native Host desconectado durante o salvamento."
                            )
                        );
                    }
                }
            );


            port.postMessage({

                action:
                    "save-audio",

                folder:
                    folder,

                filename:
                    filename,

                chunks:
                    chunks
            });
        }
    );
}


// ================================================================
// RESOLVER CURSO / MODULO / NUMERO DA AULA A PARTIR DO TITULO
// ================================================================
//
// A extensao detecta o titulo direto da pagina (ex: "01 - Curso Vray 6 -
// Apresentacao"). Sem selecao manual, curso/modulo/numero da aula precisam
// ser derivados desse titulo e criados automaticamente no Supabase se ainda
// nao existirem. Formato esperado: "<numero> - <curso> - <titulo da aula>".
// Quando o titulo nao segue esse formato, cai num curso generico e o numero
// da aula vira sequencial dentro do modulo.

async function resolverCursoModulo(title, token, moduleName) {

    const tituloBruto = (title || "aula").trim();

    const match = tituloBruto.match(
        /^\s*(\d+)\s*-\s*(.+?)\s*-\s*(.+?)\s*$/
    );

    const courseName = match ? match[2] : "Aulas sem curso identificado";
    const lessonTitle = match ? match[3] : tituloBruto;
    let lessonNumber = match ? parseInt(match[1], 10) : null;

    const moduleNameLimpo = (moduleName || "").trim();

    // ============================================================
    // MODULO (busca global antes de decidir o curso)
    // ============================================================
    // O texto do curso no título da aba é só a marca/branding da página —
    // não é confiável pra identificar o software (ex: uma aula de Sketchup
    // pode ter "Curso Vray 6" no título por causa da marca genérica do
    // site). O nome do módulo (ex: "SKETCHUP 2024/2025") é quem realmente
    // identifica o curso/software. Por isso: primeiro procuramos um módulo
    // já existente com esse nome em QUALQUER curso; se achar, usamos o
    // curso dele — assim, todo mundo que manda aula do mesmo software cai
    // sempre no mesmo lugar, não importa o que o título da aba diga.
    // ============================================================

    let mod = null;
    let course = null;

    if (moduleNameLimpo) {
        mod = (
            await A3Supabase.restSelect(
                "modules",
                `select=id,course_id&name=eq.${encodeURIComponent(moduleNameLimpo)}&limit=1`,
                token
            )
        )[0];

        if (mod) {
            course = { id: mod.course_id };
        }
    }

    if (!course) {
        course = (
            await A3Supabase.restSelect(
                "courses",
                `select=id&name=eq.${encodeURIComponent(courseName)}`,
                token
            )
        )[0];
    }

    if (!course) {
        course = await A3Supabase.restInsert(
            "courses",
            { name: courseName },
            token
        );
    }

    // Nunca assumimos "módulo 1" às cegas: cursos podem já ter uma
    // grade real pré-cadastrada (ex.: módulo 1 sendo "SKETCHUP
    // 2024/2025"), e jogar toda aula sem número de módulo detectado
    // ali dentro polui o progresso desse módulo. Se não achamos o módulo
    // pelo nome globalmente (acima), tentamos de novo só dentro do curso
    // resolvido; se ainda assim não existir, caímos num módulo "coringa"
    // isolado, que nunca colide com módulos reais da grade.

    if (!mod && moduleNameLimpo) {
        mod = (
            await A3Supabase.restSelect(
                "modules",
                `select=id&course_id=eq.${course.id}&name=eq.${encodeURIComponent(moduleNameLimpo)}`,
                token
            )
        )[0];
    }

    if (!mod && moduleNameLimpo) {
        const existentesCurso = await A3Supabase.restSelect(
            "modules",
            `select=module_number&course_id=eq.${course.id}&order=module_number.desc&limit=1`,
            token
        );

        const proximoNumero = existentesCurso[0]
            ? existentesCurso[0].module_number + 1
            : 1;

        mod = await A3Supabase.restInsert(
            "modules",
            {
                course_id: course.id,
                module_number: proximoNumero,
                name: moduleNameLimpo
            },
            token
        );
    }

    if (!mod) {
        mod = (
            await A3Supabase.restSelect(
                "modules",
                `select=id&course_id=eq.${course.id}&name=eq.Aulas sem módulo identificado`,
                token
            )
        )[0];
    }

    if (!mod) {
        const existentesCurso = await A3Supabase.restSelect(
            "modules",
            `select=module_number&course_id=eq.${course.id}&order=module_number.desc&limit=1`,
            token
        );

        const proximoNumero = existentesCurso[0]
            ? existentesCurso[0].module_number + 1
            : 1;

        mod = await A3Supabase.restInsert(
            "modules",
            {
                course_id: course.id,
                module_number: proximoNumero,
                name: "Aulas sem módulo identificado"
            },
            token
        );
    }

    if (lessonNumber === null) {

        const existentes = await A3Supabase.restSelect(
            "lessons",
            `select=lesson_number&module_id=eq.${mod.id}&order=lesson_number.desc&limit=1`,
            token
        );

        lessonNumber = existentes[0]
            ? existentes[0].lesson_number + 1
            : 1;
    }

    return {
        courseId: course.id,
        moduleId: mod.id,
        lessonNumber,
        lessonTitle
    };
}


// ================================================================
// UPLOAD PARA O SUPABASE (compartilhado entre o fluxo normal de
// "Parar" e a reconciliação de sessões interrompidas)
// ================================================================

async function enviarParaSupabase({
    title,
    moduleName,
    filename,
    audioBlob,
    recordingGroupId,
    segmentIndex,
    isFinal
}) {

    const token = await A3Session.getValidAccessToken();
    const user = await A3Session.getCurrentUser();

    if (!token || !user) {
        throw new Error("Sessão expirada. Faça login novamente.");
    }

    const selection = await resolverCursoModulo(title, token, moduleName);

    const lessonRow = await A3Supabase.restInsert(
        "lessons",
        {
            module_id: selection.moduleId,
            lesson_number: selection.lessonNumber,
            title: selection.lessonTitle
        },
        token
    ).catch(async () => {
        const existing = await A3Supabase.restSelect(
            "lessons",
            `select=id&module_id=eq.${selection.moduleId}&lesson_number=eq.${selection.lessonNumber}`,
            token
        );
        return existing[0];
    });

    // O Supabase Storage rejeita chaves com espaco/acento mesmo
    // com URL-encoding (valida a chave decodificada). O nome
    // original (com espacos/acentos) continua guardado em
    // audio_files.filename para exibicao.
    const nomeStorageSeguro = filename
        .normalize("NFD")
        .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
        .replace(/[^A-Za-z0-9._-]/g, "_");

    const storagePath = `${selection.courseId}/${selection.moduleId}/${lessonRow.id}/${nomeStorageSeguro}`;

    await A3Supabase.uploadToStorage("audio", storagePath, audioBlob, token);

    const audioFileRow = await A3Supabase.restInsert(
        "audio_files",
        {
            course_id: selection.courseId,
            module_id: selection.moduleId,
            lesson_id: lessonRow.id,
            uploaded_by: user.id,
            storage_path: storagePath,
            filename: filename,
            mime_type: "audio/webm",
            file_size: audioBlob.size,
            status: "uploaded",
            recording_group_id: recordingGroupId,
            segment_index: segmentIndex,
            is_final: isFinal
        },
        token
    );

    // Segmentos intermediários de um grupo (is_final: false) não geram
    // job de transcrição sozinhos — a junção (Task 10, supabase_worker.py)
    // só roda quando o segmento final sobe, e o job criado ali cobre o
    // grupo inteiro.
    if (isFinal) {
        await A3Supabase.restInsert(
            "transcription_jobs",
            {
                audio_file_id: audioFileRow.id,
                status: "pending"
            },
            token
        );
    }

    return audioFileRow;
}


// ================================================================
// MENSAGENS
// ================================================================

chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {


        // ========================================================
        // STATUS
        // ========================================================

        if (
            message.action ===
            "get-recording-status"
        ) {

            (async () => {

                const gravandoDeVerdade =
                    await consultarOffscreenGravando();

                await carregarEstado();

                if (recording !== gravandoDeVerdade) {

                    await salvarEstado({
                        recording: gravandoDeVerdade
                    });
                }

                sendResponse({

                    recording:
                        gravandoDeVerdade
                });

            })();

            return true;
        }


        // ========================================================
        // SELECIONAR PASTA
        // ========================================================

        if (
            message.action ===
            "select-folder"
        ) {

            selecionarPastaNative()

                .then(
                    response => {

                        sendResponse(
                            response
                        );
                    }
                )

                .catch(
                    error => {

                        console.error(
                            "Native Host:",
                            error
                        );

                        sendResponse({

                            success:
                                false,

                            error:
                                error.message
                        });
                    }
                );

            return true;
        }


        // ========================================================
        // INICIAR
        // ========================================================

        if (
            message.action ===
            "start-recording"
        ) {

            iniciarGravacao(

                message.title,

                message.outputFolder,

                message.moduleName

            ).then(
                response => {

                    sendResponse(
                        response
                    );
                }
            );


            return true;
        }


        // ========================================================
        // PARAR
        // ========================================================

        if (
            message.action ===
            "stop-recording"
        ) {

            pararGravacao()

                .then(
                    response => {

                        sendResponse(
                            response
                        );
                    }
                );


            return true;
        }


        // ========================================================
        // OFFSCREEN TERMINOU
        // ========================================================

        if (
            message.target ===
            "background" &&

            message.action ===
            "recording-finished"
        ) {

            (async () => {

                await carregarEstado();

                try {

                    if (
                        currentRecording.outputFolder &&
                        currentRecording.outputFolder.trim()
                    ) {

                        try {

                            await salvarAudioNative(

                                currentRecording.outputFolder,

                                message.filename,

                                message.chunks
                            );

                        } catch (nativeError) {

                            console.error(
                                "A3-OS: falha ao salvar cópia local (Native Host), seguindo só com o Supabase:",
                                nativeError
                            );
                        }
                    }


                    try {

                        chrome.runtime.sendMessage({
                            action: "upload-status",
                            stage: "uploading"
                        });

                        const lessonKey = currentRecording.lessonKey || null;
                        const groups = lessonKey ? await A3RecordingGroups.getGroups() : {};
                        const existingGroup = lessonKey ? groups[lessonKey] : null;

                        // message.chunks são strings base64 (contrato com o Native Host, NÃO alterar
                        // o que é passado para salvarAudioNative). Para o upload ao Supabase, os
                        // bytes reais do áudio precisam ser decodificados antes de montar o Blob,
                        // senão o arquivo enviado é texto base64 em vez do áudio binário.
                        const audioByteArrays = message.chunks.map((chunk) => {
                            const binary = atob(chunk);
                            const bytes = new Uint8Array(binary.length);
                            for (let i = 0; i < binary.length; i++) {
                                bytes[i] = binary.charCodeAt(i);
                            }
                            return bytes;
                        });

                        const audioBlob = new Blob(audioByteArrays, { type: "audio/webm" });

                        await enviarParaSupabase({
                            title: currentRecording.title,
                            moduleName: currentRecording.moduleName,
                            filename: message.filename,
                            audioBlob,
                            recordingGroupId: existingGroup ? existingGroup.recordingGroupId : null,
                            segmentIndex: existingGroup ? existingGroup.nextSegmentIndex : null,
                            isFinal: true
                        });

                        if (existingGroup) {
                            await A3RecordingGroups.closeGroup(lessonKey);
                        }

                        if (message.sessionId) {
                            chrome.runtime.sendMessage({
                                target: "offscreen",
                                action: "delete-backup-chunks",
                                sessionId: message.sessionId
                            });
                        }

                        chrome.runtime.sendMessage({
                            action: "upload-status",
                            stage: "done"
                        });

                    } catch (uploadError) {

                        console.error("A3-OS: erro no upload para o Supabase:", uploadError);

                        chrome.runtime.sendMessage({
                            action: "upload-status",
                            stage: "error",
                            error: uploadError.message
                        });
                    }


                    await salvarEstado({
                        recording: false
                    });


                    chrome.action.setIcon({
                        path: ICON_NORMAL
                    });


                    chrome.runtime.sendMessage({

                        action:
                            "download-success",

                        filename:
                            message.filename
                    });


                    console.log(
                        "A3-OS Recorder: áudio salvo com sucesso."
                    );

                } catch (error) {

                    await salvarEstado({
                        recording: false
                    });


                    chrome.action.setIcon({
                        path: ICON_NORMAL
                    });


                    console.error(
                        "Erro ao salvar áudio:",
                        error
                    );


                    chrome.runtime.sendMessage({

                        action:
                            "download-error",

                        error:
                            error.message
                    });
                }

            })();


            return false;
        }


        // ========================================================
        // LOGIN
        // ========================================================

        if (message.action === "login") {

            A3Session.login(message.email, message.password)
                .then(user => {
                    sendResponse({ success: true, user });
                })
                .catch(error => {
                    sendResponse({ success: false, error: error.message });
                });

            return true;
        }


        // ========================================================
        // LOGOUT
        // ========================================================

        if (message.action === "logout") {

            A3Session.logout()
                .then(() => {
                    sendResponse({ success: true });
                })
                .catch(error => {
                    sendResponse({ success: false, error: error.message });
                });

            return true;
        }


        // ========================================================
        // SESSAO ATUAL
        // ========================================================

        if (message.action === "get-current-user") {

            (async () => {

                const user = await A3Session.getCurrentUser();

                if (!user) {
                    sendResponse({ user: null });
                    return;
                }

                let displayName = null;

                try {

                    const token = await A3Session.getValidAccessToken();

                    const profiles = await A3Supabase.restSelect(
                        "profiles",
                        `select=display_name&id=eq.${user.id}`,
                        token
                    );

                    displayName = profiles?.[0]?.display_name || null;

                } catch (error) {

                    console.warn("Erro ao buscar nome do usuário:", error);
                }

                sendResponse({ user: { ...user, displayName } });

                enviarHeartbeat();

            })();

            return true;
        }


        // ========================================================
        // LISTAR CURSOS
        // ========================================================

        if (message.action === "get-courses") {

            (async () => {

                try {

                    const token = await A3Session.getValidAccessToken();

                    if (!token) {
                        sendResponse({ courses: [], error: "not-authenticated" });
                        return;
                    }

                    const courses = await A3Supabase.restSelect(
                        "courses",
                        "select=id,name&order=name.asc",
                        token
                    );

                    sendResponse({ courses });

                } catch (error) {

                    sendResponse({ courses: [], error: error.message });
                }

            })();

            return true;
        }


        // ========================================================
        // HISTORICO DE ENVIOS DO USUARIO
        // ========================================================

        if (message.action === "get-upload-history") {

            (async () => {

                try {

                    const token = await A3Session.getValidAccessToken();
                    const user = await A3Session.getCurrentUser();

                    if (!token || !user) {
                        sendResponse({ history: [], error: "not-authenticated" });
                        return;
                    }

                    // Sem filtro de data: mantém o comportamento original (últimos 20).
                    // Com filtro: sobe o teto pra não cortar um dia com muitos envios.
                    const temFiltroData = Boolean(message.startDate && message.endDate);
                    const limite = temFiltroData ? 200 : 20;
                    const filtroData = temFiltroData
                        ? `&created_at=gte.${encodeURIComponent(message.startDate)}&created_at=lt.${encodeURIComponent(message.endDate)}`
                        : "";

                    const history = await A3Supabase.restSelect(
                        "audio_files",
                        `select=id,filename,created_at,status,duration,duracao_suspeita,duracao_tipo,duracao_esperada_segundos,lessons(title,lesson_number),modules(name,module_number),courses(name),knowledge_sync_status(status,created_at)&uploaded_by=eq.${user.id}${filtroData}&order=created_at.desc&limit=${limite}`,
                        token
                    );

                    sendResponse({ history });

                } catch (error) {

                    sendResponse({ history: [], error: error.message });
                }

            })();

            return true;
        }


        // ========================================================
        // LISTAR MODULOS DE UM CURSO
        // ========================================================

        if (message.action === "get-modules") {

            (async () => {

                try {

                    const token = await A3Session.getValidAccessToken();

                    if (!token) {
                        sendResponse({ modules: [], error: "not-authenticated" });
                        return;
                    }

                    const modules = await A3Supabase.restSelect(
                        "modules",
                        `select=id,module_number,name&course_id=eq.${message.courseId}&order=module_number.asc`,
                        token
                    );

                    sendResponse({ modules });

                } catch (error) {

                    sendResponse({ modules: [], error: error.message });
                }

            })();

            return true;
        }


        // ========================================================
        // PROGRESSO GERAL DO CURSO (todas as aulas de todos os
        // modulos, em %)
        // ========================================================

        if (message.action === "get-overall-progress") {

            (async () => {

                try {

                    const token = await A3Session.getValidAccessToken();

                    if (!token) {
                        sendResponse({ error: "not-authenticated" });
                        return;
                    }

                    const courses = await A3Supabase.restSelect(
                        "courses",
                        "select=total_lessons,modules(lessons(status))",
                        token
                    );

                    let totalLessons = 0;
                    let completedLessons = 0;

                    (courses || []).forEach((curso) => {

                        totalLessons += curso.total_lessons || 0;

                        (curso.modules || []).forEach((modulo) => {

                            const aulas = modulo.lessons || [];
                            completedLessons += aulas.filter((l) => l.status === "completed").length;
                        });
                    });

                    const percent = totalLessons > 0
                        ? Math.min(100, Math.round((completedLessons / totalLessons) * 100))
                        : 0;

                    sendResponse({
                        progress: { totalLessons, completedLessons, percent }
                    });

                } catch (error) {

                    sendResponse({ error: error.message });
                }

            })();

            return true;
        }


        // ========================================================
        // PROGRESSO DO MODULO ATUAL (aulas concluidas no modulo
        // detectado na pagina, em %)
        // ========================================================

        if (message.action === "get-module-progress") {

            (async () => {

                try {

                    const token = await A3Session.getValidAccessToken();

                    if (!token) {
                        sendResponse({ error: "not-authenticated" });
                        return;
                    }

                    const nomeModulo = (message.moduleName || "").trim();

                    if (!nomeModulo) {
                        sendResponse({ progress: { found: false } });
                        return;
                    }

                    const modules = await A3Supabase.restSelect(
                        "modules",
                        `select=name,total_lessons,lessons(status)&name=eq.${encodeURIComponent(nomeModulo)}`,
                        token
                    );

                    const modulo = modules?.[0];

                    if (!modulo) {
                        sendResponse({ progress: { found: false, moduleName: nomeModulo } });
                        return;
                    }

                    const aulas = modulo.lessons || [];
                    const completed = aulas.filter((l) => l.status === "completed").length;
                    const total = modulo.total_lessons || 0;
                    const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

                    sendResponse({
                        progress: {
                            found: true,
                            moduleName: modulo.name,
                            completed,
                            total,
                            percent
                        }
                    });

                } catch (error) {

                    sendResponse({ error: error.message });
                }

            })();

            return true;
        }
    }
);
