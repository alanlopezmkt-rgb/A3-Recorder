importScripts("config.js", "lib/supabase.js", "lib/session.js");

let recording = false;

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
    outputFolder
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


        if (
            !outputFolder ||
            !outputFolder.trim()
        ) {

            throw new Error(
                "Nenhuma pasta de destino configurada."
            );
        }


        await salvarEstado({

            currentRecording: {

                title:
                    title ||
                    "aula",

                outputFolder:
                    outputFolder
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
                    currentRecording.title
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
                        "com.a3os.folderpicker"
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
                        "com.a3os.folderpicker"
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

                message.outputFolder

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

                    const response =
                        await salvarAudioNative(

                            currentRecording.outputFolder,

                            message.filename,

                            message.chunks
                        );


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
                            response.filename ||
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

            A3Session.getCurrentUser()
                .then(user => {
                    sendResponse({ user });
                });

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
    }
);
