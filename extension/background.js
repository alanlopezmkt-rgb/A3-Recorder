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

const GROUP_EXPIRY_ALARM = "a3os-group-expiry-sweep";
const GROUP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

chrome.alarms.create(HEARTBEAT_ALARM, {
    periodInMinutes: HEARTBEAT_INTERVAL_MINUTES
});

chrome.alarms.get(GROUP_EXPIRY_ALARM, (alarmeExistente) => {

    if (!alarmeExistente) {

        chrome.alarms.create(GROUP_EXPIRY_ALARM, {
            periodInMinutes: 24 * 60 // uma vez por dia
        });
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {

    if (alarm.name === HEARTBEAT_ALARM) {
        enviarHeartbeat();
    }

    if (alarm.name === GROUP_EXPIRY_ALARM) {
        varrerGruposExpirados();
    }
});

enviarHeartbeat();

let currentRecording = {
    title: "aula",
    outputFolder: ""
};

let pendingIncompleteStop = false;


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

// Mostrado na aba (setIcon com tabId) quando essa aba tem uma aula com
// gravacao incompleta (grupo aberto) — chama atencao antes mesmo de abrir
// o popup. So se aplica aquela aba especifica, nunca o icone global.
const ICON_WARNING = {

    "16": "icons/icon-warning-16.png",
    "48": "icons/icon-warning-48.png",
    "128": "icons/icon-warning-128.png"
};

// ================================================================
// ATUALIZACAO AUTOMATICA DO ICONE (aula incompleta) — antes so'
// rodava quando o popup era aberto, entao o icone so' avisava depois
// de clicar na extensao. Detecta o titulo/modulo da aba (mesmo metodo
// que o popup usa) e compara com os grupos de gravacao abertos, sem
// depender do popup estar aberto.
// ================================================================

async function detectarAulaNaAba(tabId) {

    try {

        const result = await chrome.scripting.executeScript({

            target: { tabId },

            func: () => {

                const h1 = document.querySelector("h1");

                const title =
                    h1 && h1.innerText && h1.innerText.trim()
                        ? h1.innerText.trim()
                        : (document.title || "");

                const IGNORAR = ["voltar", "avançar", "avancar", "próxima", "proxima", "anterior"];

                const candidatos = Array.from(
                    document.querySelectorAll(".text-foreground")
                ).filter((el) => {
                    const texto = (el.innerText || "").trim();
                    if (!texto || IGNORAR.includes(texto.toLowerCase())) {
                        return false;
                    }
                    if (h1 && (el === h1 || el.contains(h1) || h1.contains(el))) {
                        return false;
                    }
                    if (h1) {
                        const posicao = h1.compareDocumentPosition(el);
                        return !!(posicao & Node.DOCUMENT_POSITION_PRECEDING);
                    }
                    return true;
                });

                const moduloElement = candidatos[candidatos.length - 1] || null;

                const moduleName =
                    moduloElement && moduloElement.innerText && moduloElement.innerText.trim()
                        ? moduloElement.innerText.trim()
                        : null;

                return { title, moduleName };
            }
        });

        return result?.[0]?.result || null;

    } catch (error) {

        // Aba sem permissao (chrome://, pagina de outra extensao,
        // ainda carregando) — nao e' uma aula, ignora silenciosamente.
        return null;
    }
}

// A gravação captura o áudio da aba em tempo real (1 minuto gravado =
// 1 minuto de relógio), mas se o usuário assiste em velocidade
// diferente de 1x (ex.: 1.5x), 1 minuto de relógio cobre 1.5 minuto de
// conteúdo da aula. Sem isso, uma aula assistida inteira a 1.5x aparece
// como "76% gravada" (tempo de relógio ÷ duração da aula a 1x) mesmo
// tendo sido concluída — e o aviso de "duração menor que o esperado"
// dispara à toa. Lê o playbackRate do <video> da aba pra converter
// segundos-de-relógio em segundos-de-conteúdo-coberto.
async function detectarVelocidadeReproducao(tabId) {

    if (tabId === undefined || tabId === null || tabId < 0) {
        return 1;
    }

    try {

        const result = await chrome.scripting.executeScript({

            target: { tabId },

            func: () => {
                const video = document.querySelector("video");
                const rate = video && typeof video.playbackRate === "number"
                    ? video.playbackRate
                    : 1;
                // Sanidade: um playbackRate zerado/negativo/absurdo (bug da
                // página, vídeo ainda não inicializado) nunca deve distorcer
                // a minutagem — melhor assumir 1x do que multiplicar errado.
                return (rate > 0 && rate <= 4) ? rate : 1;
            }
        });

        return result?.[0]?.result || 1;

    } catch (error) {

        // Aba fechada, sem permissão, sem <video> — assume 1x (comportamento
        // anterior), nunca quebra o fluxo de parar a gravação por causa disso.
        return 1;
    }
}

async function atualizarIconeDaAba(tabId) {

    if (tabId === undefined || tabId === null || tabId < 0) {
        return;
    }

    try {

        // Nunca sobrepor o icone de gravacao em andamento. Este metodo
        // roda em eventos de aba e num alarme de 30s; sem esta guarda ele
        // trocava o icone vermelho de "gravando" por ICON_NORMAL/WARNING
        // no meio da gravacao.
        const estado = await carregarEstado();
        if (estado.recording) {
            chrome.action.setIcon({ tabId, path: ICON_RECORDING });
            return;
        }

        const deteccao = await detectarAulaNaAba(tabId);

        if (!deteccao || !deteccao.title) {
            chrome.action.setIcon({ tabId, path: ICON_NORMAL });
            return;
        }

        const lessonKey = A3LessonKey.lessonKey(deteccao.title, deteccao.moduleName);
        const groups = await A3RecordingGroups.getGroups();
        const grupoAberto = groups[lessonKey] || null;

        chrome.action.setIcon({
            tabId,
            path: grupoAberto ? ICON_WARNING : ICON_NORMAL
        });

    } catch (error) {

        console.error("A3-OS: falha ao atualizar icone automaticamente para a aba", tabId, error);
    }
}

// Cobre troca de aba e navegacao/carregamento — o caso comum de abrir
// ou trocar de aula sem precisar clicar na extensao pra descobrir que
// ficou incompleta.
chrome.tabs.onActivated.addListener(({ tabId }) => {
    atualizarIconeDaAba(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.active) {
        atualizarIconeDaAba(tabId);
    }
});

// A plataforma de aulas e' uma SPA — trocar de aula dentro dela as
// vezes so' troca o conteudo da pagina, sem disparar onUpdated
// "complete" de novo. Um alarme periodico cobre esse caso, olhando so'
// as abas ativas de cada janela aberta.
const ALARME_ICONE_AULA = "a3-atualizar-icone-aula";

chrome.alarms.create(ALARME_ICONE_AULA, { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {

    if (alarm.name !== ALARME_ICONE_AULA) {
        return;
    }

    (async () => {

        const abasAtivas = await chrome.tabs.query({ active: true });

        for (const aba of abasAtivas) {
            atualizarIconeDaAba(aba.id);
        }
    })();
});


// ================================================================
// FORMATACAO DE DURACAO PARA NOTIFICACOES
// ================================================================

function formatarDuracaoNotificacao(segundos) {
    const min = Math.floor(segundos / 60);
    const seg = Math.round(segundos % 60);
    return `${min}min ${seg}s`;
}


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

    if (
        Object.prototype.hasOwnProperty.call(
            parcial,
            "pendingIncompleteStop"
        )
    ) {

        pendingIncompleteStop = parcial.pendingIncompleteStop;
    }

    await chrome.storage.session.set(parcial);
}

async function carregarEstado() {

    const dados =
        await chrome.storage.session.get(
            ["recording", "currentRecording", "pendingIncompleteStop"]
        );

    recording =
        !!dados.recording;

    currentRecording =
        dados.currentRecording ||
        currentRecording;

    pendingIncompleteStop =
        !!dados.pendingIncompleteStop;

    return {
        recording,
        currentRecording,
        pendingIncompleteStop
    };
}


// ================================================================
// MARCADORES DE RECUPERAÇÃO (persistentes, sobrevivem ao fechamento
// do Chrome/PC — diferente de chrome.storage.session, que é apagado
// exatamente no crash que estes marcadores existem para detectar)
//
// Um mapa (nao um valor unico) porque o usuario pode iniciar uma nova
// gravacao enquanto o upload de uma gravacao anterior ainda esta' em
// andamento (ex.: proxima aula, antes do upload lento da anterior
// terminar) - cada sessao precisa do seu proprio marcador, indexado
// por sessionId, para que uma nao apague ou sobrescreva a da outra.
// ================================================================

async function salvarMarcadorRecuperacao(sessionId, dados) {

    const armazenado =
        await chrome.storage.local.get(["a3RecoverySessions"]);

    const marcadores =
        armazenado.a3RecoverySessions || {};

    marcadores[sessionId] = dados;

    await chrome.storage.local.set({
        a3RecoverySessions: marcadores
    });
}

async function marcarMarcadorComoFinal(sessionId) {

    const armazenado =
        await chrome.storage.local.get(["a3RecoverySessions"]);

    const marcadores =
        armazenado.a3RecoverySessions || {};

    if (!marcadores[sessionId]) {
        return;
    }

    marcadores[sessionId] = {
        ...marcadores[sessionId],
        isFinal: true
    };

    await chrome.storage.local.set({
        a3RecoverySessions: marcadores
    });
}

async function listarMarcadoresRecuperacao() {

    const armazenado =
        await chrome.storage.local.get(["a3RecoverySessions"]);

    const marcadores =
        armazenado.a3RecoverySessions || {};

    return Object.keys(marcadores).map((sessionId) => ({
        sessionId,
        ...marcadores[sessionId]
    }));
}

async function limparMarcadorRecuperacao(sessionId) {

    const armazenado =
        await chrome.storage.local.get(["a3RecoverySessions"]);

    const marcadores =
        armazenado.a3RecoverySessions || {};

    delete marcadores[sessionId];

    await chrome.storage.local.set({
        a3RecoverySessions: marcadores
    });
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

        const lessonKey = A3LessonKey.lessonKey(title, moduleName);

        let grupoAberto = null;
        try {
            const groups = await A3RecordingGroups.getGroups();
            grupoAberto = groups[lessonKey] || null;
        } catch (erroGrupos) {
            console.error("A3-OS: falha ao consultar grupos de gravação abertos, seguindo sem banner:", erroGrupos);
        }

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
                success: true,
                grupoAberto: grupoAberto ? { totalRecordedSeconds: grupoAberto.totalRecordedSeconds } : null
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
                    sessionId,

                // Guardado pra, ao parar, ler a velocidade de reprodução
                // (video.playbackRate) da própria aba e corrigir a
                // minutagem gravada — ver detectarVelocidadeReproducao.
                tabId:
                    tab.id,

                startedAt:
                    Date.now()
            }
        });

        await salvarMarcadorRecuperacao(sessionId, {
            lessonKey,
            title: title || "aula",
            outputFolder: outputFolder,
            moduleName: moduleName || null,
            isFinal: false
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
            success: true,
            grupoAberto: grupoAberto ? { totalRecordedSeconds: grupoAberto.totalRecordedSeconds } : null
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
// RECONCILIACAO DE SESSAO ORFA (Chrome fechou no meio de uma
// gravacao: o offscreen morreu sem passar por "Parar", mas os
// chunks da sessao continuam no IndexedDB)
// ================================================================

async function reconciliarSessaoOrfa() {

    const marcadores = await listarMarcadoresRecuperacao();

    if (!marcadores.length) {
        return;
    }

    const gravandoDeVerdade = await consultarOffscreenGravando();

    // So' existe um MediaRecorder ativo por vez no offscreen, entao no
    // maximo UM dos marcadores pendentes pode corresponder a uma
    // gravacao genuinamente em andamento (SW so' reiniciou, Chrome
    // continua aberto). Identifica qual e' esse, usando o sessionId
    // ja' guardado em chrome.storage.session pelo proprio
    // iniciarGravacao - essa leitura e' confiavel aqui porque, se
    // gravandoDeVerdade e' true, o Chrome nunca fechou (so' o service
    // worker reiniciou), entao chrome.storage.session nunca foi limpo.
    let liveSessionId = null;

    if (gravandoDeVerdade) {

        const estado = await carregarEstado();

        liveSessionId =
            estado.currentRecording &&
            estado.currentRecording.sessionId;

        await salvarEstado({
            recording: true,
            currentRecording: estado.currentRecording
        });

        chrome.action.setIcon({ path: ICON_RECORDING });

    } else {

        await salvarEstado({ recording: false });
        chrome.action.setIcon({ path: ICON_NORMAL });
    }

    for (const marcador of marcadores) {

        if (gravandoDeVerdade && marcador.sessionId === liveSessionId) {
            // Sessao genuinamente em andamento - nada a reconciliar
            // para essa entrada especifica.
            continue;
        }

        try {

            const chunks = await A3RecordingBackupDb.getChunksBySession(marcador.sessionId);

            if (!chunks.length) {
                // Nada foi salvo a tempo (interrupcao antes do primeiro
                // tick de 30s) - nao ha' o que recuperar.
                await limparMarcadorRecuperacao(marcador.sessionId);
                continue;
            }

            console.log(`A3-OS Recorder: recuperando sessão interrompida (${chunks.length} pedaço(s)).`);

            const groups = await A3RecordingGroups.getGroups();
            let group = groups[marcador.lessonKey];

            const audioBlob = new Blob(chunks.map((c) => c.blob), { type: "audio/webm" });

            const filenameBase = (marcador.title || "aula")
                .replace(/[<>:"/\\|?*#%]/g, "")
                .replace(/\s+/g, " ")
                .trim() || "aula";

            const filename = `${filenameBase}_${Date.now()}.webm`;

            if (marcador.isFinal) {

                // Era um "Parar" deliberado que nao terminou de subir
                // (crash durante o upload) - finaliza como segmento
                // final, levando junto os trechos anteriores ja'
                // enviados so' pro Storage, e fecha o grupo.

                await enviarParaSupabase({
                    title: marcador.title,
                    moduleName: marcador.moduleName,
                    filename,
                    audioBlob,
                    recordingGroupId: group ? group.recordingGroupId : null,
                    segmentIndex: group ? group.nextSegmentIndex : null,
                    isFinal: true,
                    segmentStoragePaths: group ? (group.segmentPaths || []) : []
                });

                if (group) {
                    await A3RecordingGroups.closeGroup(marcador.lessonKey);
                }

            } else {

                // Interrupcao abrupta no meio de uma gravacao - sobe o
                // trecho SO' pro Storage e guarda o caminho no grupo
                // (nada em audio_files ate' a aula ser finalizada).

                // A duracao exata do segmento recuperado e' desconhecida
                // (o IndexedDB so' guarda os blobs), mas o MediaRecorder
                // grava com timeslice de 30s (offscreen.js, mediaRecorder.
                // start(30000)), entao chunks.length * 30 e' uma
                // aproximacao aceitavel so' para informar ao usuario
                // quantos minutos foram capturados (nunca usada para a
                // decisao de isFinal).
                const duracaoAproximadaSegundos = chunks.length * 30;

                const caminhoTrecho = await subirTrechoIncompleto({
                    title: marcador.title,
                    moduleName: marcador.moduleName,
                    filename,
                    audioBlob
                });

                if (!group) {
                    group = await A3RecordingGroups.createGroup(marcador.lessonKey, {
                        ...marcador,
                        segmentDurationSeconds: duracaoAproximadaSegundos,
                        segmentPath: caminhoTrecho
                    });
                    // Grupo recem-criado ja' nasce com esse trecho
                    // (duracao + caminho) contabilizado — so' avanca o
                    // indice do proximo segmento.
                    await A3RecordingGroups.bumpSegmentIndex(marcador.lessonKey);
                } else {
                    await A3RecordingGroups.addSegmentPath(
                        marcador.lessonKey,
                        caminhoTrecho,
                        duracaoAproximadaSegundos
                    );
                }

                try {

                    chrome.notifications.create(`a3-recovery-${marcador.sessionId}`, {
                        type: "basic",
                        iconUrl: "icons/icon-normal-128.png",
                        title: "A3-OS Recorder",
                        message:
                            `Recuperamos parte da aula "${marcador.title}"${marcador.moduleName ? ` (${marcador.moduleName})` : ""}: ` +
                            `${formatarDuracaoNotificacao(duracaoAproximadaSegundos)} gravados antes de fechar. Já enviamos — ` +
                            `grave essa aula de novo para completar; vamos continuar de onde parou automaticamente.`
                    });

                } catch (notificationError) {

                    // Falha aqui (permissao negada pelo SO, id invalido) nunca pode
                    // abortar a limpeza do marcador de recuperacao logo abaixo -
                    // senao o marcador fica vivo e o mesmo segmento e' reenviado
                    // (duplicado) na proxima reconciliacao.
                    console.error("A3-OS Recorder: falha ao criar notificação de recuperação:", notificationError);
                }
            }

            await A3RecordingBackupDb.deleteChunksBySession(marcador.sessionId);
            await limparMarcadorRecuperacao(marcador.sessionId);

            console.log("A3-OS Recorder: segmento recuperado e enviado com sucesso.");

        } catch (error) {

            // Falha aqui (sem internet, sessao expirada) nao apaga nada
            // dessa entrada - o marcador e os chunks dessa sessao
            // continuam para a proxima reconciliacao (proximo boot)
            // tentar de novo. Continua o loop para as outras entradas
            // pendentes, se houver.
            console.error(`A3-OS Recorder: falha na reconciliação de sessão órfã (${marcador.sessionId}):`, error);
        }
    }
}

chrome.runtime.onStartup.addListener(reconciliarSessaoOrfa);
reconciliarSessaoOrfa();

// ================================================================
// VARREDURA DE GRUPOS EXPIRADOS (aula interrompida ha' mais de 7
// dias sem retomada - fecha o grupo automaticamente, marcando o
// ultimo segmento enviado como final para nao deixar a transcricao
// pendente para sempre)
// ================================================================

async function varrerGruposExpirados() {

    try {

        const expirados = await A3RecordingGroups.listExpiredGroups(GROUP_EXPIRY_MS);

        for (const grupo of expirados) {

            try {

                const token = await A3Session.getValidAccessToken();
                const user = await A3Session.getCurrentUser();

                if (!token || !user) {
                    continue;
                }

                // Sob a Opção B, uma gravação incompleta não tem NENHUMA
                // linha em audio_files — só os caminhos dos trechos no
                // Storage, em grupo.segmentPaths. Ao expirar sem retomada,
                // criamos UMA linha final a partir desses trechos (o
                // último vira o storage_path; os anteriores entram em
                // segment_storage_paths) + o job, para o worker juntar e
                // transcrever o que já foi gravado.
                const caminhos = grupo.segmentPaths || [];

                if (caminhos.length) {

                    const ultimoCaminho = caminhos[caminhos.length - 1];
                    const anteriores = caminhos.slice(0, -1);
                    const nomeArquivo = ultimoCaminho.split("/").pop() || "aula.webm";

                    const selection = await resolverCursoModulo(
                        grupo.title,
                        token,
                        grupo.moduleName
                    );

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

                    const audioFileRow = await A3Supabase.restInsert(
                        "audio_files",
                        {
                            course_id: selection.courseId,
                            module_id: selection.moduleId,
                            lesson_id: lessonRow.id,
                            uploaded_by: user.id,
                            storage_path: ultimoCaminho,
                            filename: nomeArquivo,
                            mime_type: "audio/webm",
                            status: "uploaded",
                            recording_group_id: grupo.recordingGroupId,
                            segment_index: grupo.nextSegmentIndex ?? caminhos.length,
                            is_final: true,
                            duration: grupo.totalRecordedSeconds ?? null,
                            ...(anteriores.length
                                ? { segment_storage_paths: anteriores }
                                : {})
                        },
                        token
                    );

                    await A3Supabase.restInsert(
                        "transcription_jobs",
                        {
                            audio_file_id: audioFileRow.id,
                            status: "pending"
                        },
                        token
                    );

                    console.log(`A3-OS Recorder: grupo expirado (${grupo.lessonKey}) finalizado automaticamente após 7 dias com ${caminhos.length} trecho(s).`);
                }

                await A3RecordingGroups.closeGroup(grupo.lessonKey);

            } catch (error) {

                console.error(`A3-OS Recorder: falha ao expirar grupo ${grupo.lessonKey}:`, error);
                // Nao fecha o grupo localmente se a atualizacao no Supabase
                // falhou - tenta de novo na proxima varredura diaria.
            }
        }

    } catch (error) {

        console.error("A3-OS Recorder: falha na varredura de grupos expirados:", error);
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
// DURACAO ESPERADA DA AULA (so'-leitura, sem efeitos colaterais -
// reaproveita o mesmo parsing de titulo de resolverCursoModulo, mas
// so' com SELECTs, para nunca criar curso/modulo/aula so' para
// consultar a duracao esperada)
// ================================================================

async function buscarDuracaoEsperada(title, moduleName, token) {

    const tituloBruto = (title || "aula").trim();
    const match = tituloBruto.match(/^\s*(\d+)\s*-\s*(.+?)\s*-\s*(.+?)\s*$/);
    const courseName = match ? match[2] : "Aulas sem curso identificado";
    let lessonNumber = match ? parseInt(match[1], 10) : null;
    const moduleNameLimpo = (moduleName || "").trim();

    if (lessonNumber === null || !moduleNameLimpo) {
        // Sem número de aula detectável no título, ou sem nome de módulo:
        // não dá pra resolver a linha certa de "lessons" com segurança.
        return null;
    }

    let mod = (
        await A3Supabase.restSelect(
            "modules",
            `select=id,course_id&name=eq.${encodeURIComponent(moduleNameLimpo)}&limit=1`,
            token
        )
    )[0];

    if (!mod) {
        const course = (
            await A3Supabase.restSelect(
                "courses",
                `select=id&name=eq.${encodeURIComponent(courseName)}`,
                token
            )
        )[0];

        if (!course) {
            return null;
        }

        mod = (
            await A3Supabase.restSelect(
                "modules",
                `select=id&course_id=eq.${course.id}&name=eq.${encodeURIComponent(moduleNameLimpo)}`,
                token
            )
        )[0];
    }

    if (!mod) {
        return null;
    }

    const aula = (
        await A3Supabase.restSelect(
            "lessons",
            `select=expected_duration_seconds&module_id=eq.${mod.id}&lesson_number=eq.${lessonNumber}`,
            token
        )
    )[0];

    if (!aula || !aula.expected_duration_seconds) {
        return null;
    }

    return { expectedDurationSeconds: aula.expected_duration_seconds };
}


// ================================================================
// UPLOAD PARA O SUPABASE (compartilhado entre o fluxo normal de
// "Parar" e a reconciliação de sessões interrompidas)
// ================================================================

// Resolve curso/módulo/aula e sobe o áudio pro Storage. Não toca em
// audio_files — é o passo comum entre o trecho de gravação incompleta
// (que para aqui) e o envio final.
async function subirAudioParaStorage({ title, moduleName, filename, audioBlob }) {

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

    return { token, user, selection, lessonRow, storagePath };
}

// Trecho de uma gravação incompleta ("Parar mesmo assim"): sobe SÓ pro
// Storage. Não cria linha em audio_files nem job — nada aparece "no
// banco" até a aula ser finalizada. Retorna o caminho no Storage, que
// o chamador guarda no grupo (chrome.storage). Quando o segmento final
// subir, a lista inteira entra em audio_files.segment_storage_paths e
// o worker baixa todos os trechos + o final e junta com ffmpeg.
async function subirTrechoIncompleto({ title, moduleName, filename, audioBlob }) {

    const { storagePath } = await subirAudioParaStorage({
        title,
        moduleName,
        filename,
        audioBlob
    });

    return storagePath;
}

async function enviarParaSupabase({
    title,
    moduleName,
    filename,
    audioBlob,
    recordingGroupId,
    segmentIndex,
    isFinal,
    durationSeconds,
    segmentStoragePaths
}) {

    const { token, user, selection, lessonRow, storagePath } =
        await subirAudioParaStorage({ title, moduleName, filename, audioBlob });

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
            is_final: isFinal,
            // Segmento nao-final nunca gera transcription_job (ver
            // abaixo), entao nunca passa pelo supabase_worker.py que
            // detecta a duracao real do audio — sem isso, "duration"
            // fica nulo pra sempre e o aviso de aula incompleta mostra
            // "0:00" gravados. Pro segmento final, quem preenche a
            // duracao real (a partir do arquivo) e' o worker mesmo.
            ...(isFinal ? {} : { duration: durationSeconds ?? null }),
            // Trechos anteriores desta aula que subiram só pro Storage
            // (gravação retomada). O worker baixa cada um + este áudio
            // e junta na ordem antes de transcrever.
            ...(segmentStoragePaths && segmentStoragePaths.length
                ? { segment_storage_paths: segmentStoragePaths }
                : {})
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

            console.log(
                "[A3-OS] background recebeu stop-recording, duracaoConfirmadaIncompleta =",
                message.duracaoConfirmadaIncompleta
            );

            (async () => {

                try {
                    await salvarEstado({
                        pendingIncompleteStop: !!message.duracaoConfirmadaIncompleta
                    });
                } catch (error) {
                    console.error("A3-OS: falha ao salvar pendingIncompleteStop, seguindo mesmo assim:", error);
                }

                const response = await pararGravacao();
                sendResponse(response);
            })();


            return true;
        }


        // ========================================================
        // GRUPO ABERTO (consulta so'-leitura, usada pelo popup pra
        // avisar de aula incompleta assim que abre, sem precisar
        // clicar em GRAVAR primeiro)
        // ========================================================

        if (message.action === "get-grupo-aberto") {

            (async () => {

                try {

                    const lessonKey = A3LessonKey.lessonKey(
                        message.title,
                        message.moduleName
                    );

                    const groups = await A3RecordingGroups.getGroups();
                    const grupoAberto = groups[lessonKey] || null;

                    // Troca o icone da extensao SO na aba atual (a aula
                    // detectada e' sempre da aba ativa que abriu o popup)
                    // pra avisar de longe que aquela aula ficou incompleta.
                    try {

                        const [abaAtiva] = await chrome.tabs.query({
                            active: true,
                            currentWindow: true
                        });

                        if (abaAtiva?.id !== undefined) {

                            chrome.action.setIcon({
                                tabId: abaAtiva.id,
                                path: grupoAberto ? ICON_WARNING : ICON_NORMAL
                            });
                        }

                    } catch (erroIcone) {

                        console.error("A3-OS: falha ao atualizar icone da aba para aviso de aula incompleta:", erroIcone);
                    }

                    sendResponse({
                        grupoAberto: grupoAberto
                            ? { totalRecordedSeconds: grupoAberto.totalRecordedSeconds }
                            : null
                    });

                } catch (error) {

                    console.error("A3-OS: falha ao consultar grupo aberto ao abrir popup, seguindo sem aviso:", error);
                    sendResponse({ grupoAberto: null });
                }

            })();

            return true;
        }


        // ========================================================
        // GRUPOS ABERTOS (todos) — o popup mostra cada gravacao
        // incompleta no historico com barra de progresso, mesmo sem
        // linha em audio_files (Opcao B). Enriquece com a duracao
        // esperada da aula pra calcular a porcentagem.
        // ========================================================

        if (message.action === "list-grupos-abertos") {

            (async () => {

                try {

                    const groups = await A3RecordingGroups.getGroups();
                    const token = await A3Session.getValidAccessToken().catch(() => null);

                    const lista = [];

                    for (const [lessonKey, grupo] of Object.entries(groups)) {

                        let expectedDurationSeconds = null;

                        if (token) {
                            try {
                                const r = await buscarDuracaoEsperada(
                                    grupo.title, grupo.moduleName, token
                                );
                                expectedDurationSeconds = r ? r.expectedDurationSeconds : null;
                            } catch (e) {
                                // sem duracao esperada — a barra fica sem porcentagem
                            }
                        }

                        lista.push({
                            lessonKey,
                            title: grupo.title,
                            moduleName: grupo.moduleName,
                            totalRecordedSeconds: grupo.totalRecordedSeconds || 0,
                            lastActivityAt: grupo.lastActivityAt || null,
                            expectedDurationSeconds
                        });
                    }

                    sendResponse({ grupos: lista });

                } catch (error) {

                    console.error("A3-OS: falha ao listar grupos abertos:", error);
                    sendResponse({ grupos: [], error: error.message });
                }

            })();

            return true;
        }


        // ========================================================
        // DURACAO ESPERADA (consulta so'-leitura, usada pelo popup)
        // ========================================================

        if (message.action === "get-expected-duration") {

            (async () => {
                try {
                    const token = await A3Session.getValidAccessToken();
                    if (!token) {
                        sendResponse({ expectedDurationSeconds: null });
                        return;
                    }
                    const resultado = await buscarDuracaoEsperada(
                        message.title, message.moduleName, token
                    );
                    sendResponse(resultado || { expectedDurationSeconds: null });
                } catch (error) {
                    console.error("A3-OS Recorder: falha ao buscar duração esperada:", error);
                    sendResponse({ expectedDurationSeconds: null });
                }
            })();

            return true;
        }


        // ========================================================
        // TEMPO DECORRIDO (consulta so'-leitura, usada pelo popup)
        // ========================================================

        if (message.action === "get-elapsed-seconds") {

            (async () => {
                const estado = await carregarEstado();
                const startedAt = estado.currentRecording && estado.currentRecording.startedAt;
                sendResponse({
                    elapsedSeconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null
                });
            })();

            return true;
        }


        // ========================================================
        // VELOCIDADE DE REPRODUÇÃO (consulta so'-leitura, usada pelo
        // popup antes de decidir se mostra o aviso de "gravou menos
        // que o esperado" — ver detectarVelocidadeReproducao)
        // ========================================================

        if (message.action === "get-playback-rate") {

            (async () => {
                const estado = await carregarEstado();
                const tabId = estado.currentRecording && estado.currentRecording.tabId;
                const playbackRate = await detectarVelocidadeReproducao(tabId);
                sendResponse({ playbackRate });
            })();

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

                const estadoCarregado = await carregarEstado();
                const isFinal = !estadoCarregado.pendingIncompleteStop;

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

                        if (message.sessionId && isFinal) {

                            await marcarMarcadorComoFinal(message.sessionId);
                        }
                        // se isFinal for false, o marcador permanece isFinal:false —
                        // mesmo estado de uma sessão interrompida por crash.

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

                        if (isFinal) {

                            await enviarParaSupabase({
                                title: currentRecording.title,
                                moduleName: currentRecording.moduleName,
                                filename: message.filename,
                                audioBlob,
                                recordingGroupId: existingGroup ? existingGroup.recordingGroupId : null,
                                segmentIndex: existingGroup ? existingGroup.nextSegmentIndex : null,
                                isFinal: true,
                                // Leva junto todos os trechos anteriores
                                // desta aula que subiram só pro Storage —
                                // é a única linha em audio_files do grupo.
                                segmentStoragePaths: existingGroup ? (existingGroup.segmentPaths || []) : []
                            });

                            if (existingGroup) {
                                await A3RecordingGroups.closeGroup(lessonKey);
                            }

                        } else {

                            // Parada incompleta confirmada (isFinal === false). Sob a
                            // Opção B, o trecho sobe SÓ pro Storage e o caminho fica
                            // guardado no grupo (chrome.storage) — nada em audio_files
                            // até a aula ser finalizada. O grupo precisa existir/ser
                            // criado para acumular os caminhos (mesmo padrão usado em
                            // reconciliarSessaoOrfa).

                            const startedAt = currentRecording.startedAt;
                            const duracaoRelogioSegundos = startedAt
                                ? Math.floor((Date.now() - startedAt) / 1000)
                                // startedAt ausente (estado parcialmente restaurado / versao
                                // antiga) - usa a mesma aproximacao por chunks de
                                // reconciliarSessaoOrfa (timeslice de 30s) em vez de cair em 0.
                                : message.chunks.length * 30;

                            // Converte segundos-de-relogio em segundos-de-conteudo-coberto
                            // (ver detectarVelocidadeReproducao) - sem isso, assistir a aula
                            // inteira em 1.5x aparecia como gravacao incompleta.
                            const playbackRate = await detectarVelocidadeReproducao(currentRecording.tabId);
                            const duracaoSegmentoSegundos = Math.round(duracaoRelogioSegundos * playbackRate);

                            const caminhoTrecho = await subirTrechoIncompleto({
                                title: currentRecording.title,
                                moduleName: currentRecording.moduleName,
                                filename: message.filename,
                                audioBlob
                            });

                            if (!existingGroup) {

                                await A3RecordingGroups.createGroup(lessonKey, {
                                    title: currentRecording.title,
                                    outputFolder: currentRecording.outputFolder,
                                    moduleName: currentRecording.moduleName,
                                    segmentDurationSeconds: duracaoSegmentoSegundos,
                                    segmentPath: caminhoTrecho
                                });

                                // Grupo recem-criado ja' nasce com esse trecho
                                // (duracao + caminho) contabilizado — so' avanca
                                // o indice do proximo segmento.
                                await A3RecordingGroups.bumpSegmentIndex(lessonKey);

                            } else {

                                await A3RecordingGroups.addSegmentPath(
                                    lessonKey,
                                    caminhoTrecho,
                                    duracaoSegmentoSegundos
                                );
                            }
                        }

                        if (message.sessionId) {

                            await limparMarcadorRecuperacao(message.sessionId);

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
                        recording: false,
                        pendingIncompleteStop: false
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
                        recording: false,
                        pendingIncompleteStop: false
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
                        `select=id,filename,created_at,status,duration,is_final,duracao_suspeita,duracao_tipo,duracao_esperada_segundos,lesson_id,lessons(title,lesson_number),modules(name,module_number),courses(name),knowledge_sync_status(status,created_at)&uploaded_by=eq.${user.id}${filtroData}&order=created_at.desc&limit=${limite}`,
                        token
                    );

                    // Uma gravação incompleta ("Parar mesmo assim") sobe um
                    // segmento por tentativa antes do merge final — sem isso,
                    // cada tentativa vira uma linha própria no histórico, dando
                    // a impressão de várias aulas enviadas quando é só uma,
                    // ainda em andamento. Mantém apenas o envio mais recente de
                    // cada aula (a lista já vem ordenada por created_at desc) e
                    // esconde segmentos já incorporados a um envio final
                    // (status "merged").
                    const aulasVistas = new Set();
                    const historyDedupPorAula = [];
                    for (const item of history) {
                        if (item.status === "merged") {
                            continue;
                        }
                        // Sob a Opção B nenhuma gravação incompleta cria linha
                        // em audio_files — as que ainda estão abertas aparecem
                        // como item sintético (grupo do chrome.storage) com
                        // barra de progresso. Linhas is_final=false que sobraram
                        // do modelo antigo são escondidas aqui pra não duplicar.
                        if (item.is_final === false) {
                            continue;
                        }
                        const chaveAula = item.lesson_id || item.id;
                        if (aulasVistas.has(chaveAula)) {
                            continue;
                        }
                        aulasVistas.add(chaveAula);
                        historyDedupPorAula.push(item);
                    }

                    sendResponse({ history: historyDedupPorAula });

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
