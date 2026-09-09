let mediaRecorder = null;
let audioChunks = [];

let stream = null;
let audioContext = null;
let audioSource = null;

let recordingTitle = "aula";

let recordingLessonKey = null;
let recordingSessionId = null;
let chunkSeq = 0;


// ================================================================
// MENSAGENS
// ================================================================

chrome.runtime.onMessage.addListener(
    (
        message,
        sender,
        sendResponse
    ) => {


        // ========================================================
        // INICIAR
        // ========================================================

        if (
            message.target ===
            "offscreen" &&

            message.action ===
            "start-recording"
        ) {

            iniciarGravacao(

                message.streamId,

                message.title,

                message.lessonKey,

                message.sessionId

            )
            .then(
                () => {

                    sendResponse({
                        success: true
                    });

                }
            )
            .catch(
                error => {

                    console.error(
                        "OFFSCREEN - ERRO AO INICIAR:",
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
        // PARAR
        // ========================================================

        if (
            message.target ===
            "offscreen" &&

            message.action ===
            "stop-recording"
        ) {

            pararGravacao();

            sendResponse({
                success: true
            });

            return true;
        }


        // ========================================================
        // CONSULTAR ESTADO REAL (usado pelo background apos um
        // possivel reinicio do service worker)
        // ========================================================

        if (
            message.target ===
            "offscreen" &&

            message.action ===
            "get-recording-state"
        ) {

            sendResponse({

                recording:
                    !!mediaRecorder &&
                    mediaRecorder.state !==
                    "inactive"
            });

            return true;
        }


        if (
            message.target ===
            "offscreen" &&

            message.action ===
            "delete-backup-chunks"
        ) {

            A3RecordingBackupDb
                .deleteChunksBySession(message.sessionId)
                .then(() => sendResponse({ success: true }))
                .catch((error) => sendResponse({ success: false, error: error.message }));

            return true;
        }
    }
);


// ================================================================
// INICIAR GRAVAÇÃO
// ================================================================

async function iniciarGravacao(
    streamId,
    title,
    lessonKey,
    sessionId
) {

    if (
        mediaRecorder &&
        mediaRecorder.state !==
        "inactive"
    ) {

        return;
    }


    recordingTitle =
        title ||
        "aula";

    recordingLessonKey =
        lessonKey ||
        null;

    recordingSessionId =
        sessionId ||
        null;

    chunkSeq =
        0;


    audioChunks = [];


    // ============================================================
    // CAPTURAR ÁUDIO DA ABA
    // ============================================================

    stream =
        await navigator.mediaDevices.getUserMedia({

            audio: {

                mandatory: {

                    chromeMediaSource:
                        "tab",

                    chromeMediaSourceId:
                        streamId
                }
            },

            video:
                false
        });


    if (!stream) {

        throw new Error(
            "Não foi possível capturar o áudio da aba."
        );
    }


    // ============================================================
    // RESTAURAR ÁUDIO NOS ALTO-FALANTES
    // ============================================================

    audioContext =
        new AudioContext();


    if (
        audioContext.state ===
        "suspended"
    ) {

        await audioContext.resume();
    }


    audioSource =
        audioContext.createMediaStreamSource(
            stream
        );


    audioSource.connect(
        audioContext.destination
    );


    // ============================================================
    // MEDIA RECORDER
    // ============================================================

    const options = {

        audioBitsPerSecond:
            128000
    };


    if (
        MediaRecorder.isTypeSupported(
            "audio/webm;codecs=opus"
        )
    ) {

        options.mimeType =
            "audio/webm;codecs=opus";

    } else if (
        MediaRecorder.isTypeSupported(
            "audio/webm"
        )
    ) {

        options.mimeType =
            "audio/webm";
    }


    mediaRecorder =
        new MediaRecorder(
            stream,
            options
        );


    // ============================================================
    // DADOS
    // ============================================================

    mediaRecorder.ondataavailable =
        event => {

            if (
                event.data &&
                event.data.size > 0
            ) {

                audioChunks.push(
                    event.data
                );

                if (recordingSessionId) {

                    const seq = chunkSeq;
                    chunkSeq += 1;

                    A3RecordingBackupDb
                        .addChunk({
                            lessonKey: recordingLessonKey,
                            sessionId: recordingSessionId,
                            seq,
                            blob: event.data
                        })
                        .catch((error) => {
                            // Camada 1 e' um bonus, nao uma dependencia: se o
                            // IndexedDB falhar (quota, navegador privado etc.),
                            // a gravacao em memoria continua normalmente.
                            console.warn("A3-OS: falha ao gravar backup local do pedaço:", error);
                        });
                }
            }
        };


    // ============================================================
    // ERRO
    // ============================================================

    mediaRecorder.onerror =
        event => {

            console.error(
                "OFFSCREEN - MediaRecorder:",
                event
            );
        };


    // ============================================================
    // PAROU
    // ============================================================

    mediaRecorder.onstop =
        async () => {

            await finalizarGravacao();
        };


    // ============================================================
    // COMEÇAR
    // ============================================================

    mediaRecorder.start(30000);


    console.log(
        "A3-OS Recorder: captura iniciada."
    );
}


// ================================================================
// PARAR
// ================================================================

function pararGravacao() {

    if (!mediaRecorder) {
        return;
    }


    if (
        mediaRecorder.state !==
        "inactive"
    ) {

        mediaRecorder.stop();
    }
}


// ================================================================
// FINALIZAR
// ================================================================

async function finalizarGravacao() {

    try {

        // ========================================================
        // CRIAR BLOB
        // ========================================================

        const blob =
            new Blob(
                audioChunks,
                {
                    type:
                        "audio/webm"
                }
            );


        if (
            !blob ||
            blob.size === 0
        ) {

            throw new Error(
                "A gravação ficou vazia."
            );
        }


        console.log(
            "OFFSCREEN - Tamanho:",
            blob.size
        );


        // ========================================================
        // NOME
        // ========================================================

        let filename =
            recordingTitle

                .replace(
                    /[<>:"/\\|?*#%]/g,
                    ""
                )

                .replace(
                    /\s+/g,
                    " "
                )

                .trim();


        if (!filename) {

            filename =
                "aula";
        }


        // Timestamp evita colisão de nome quando a mesma aula é gravada
        // por usuários diferentes (ou pelo mesmo usuário em momentos
        // diferentes) — sem isso, o storage_path no Supabase colidiria.
        filename +=
            `_${Date.now()}`;


        filename +=
            ".webm";


        // ========================================================
        // CONVERTER PARA BASE64 EM CHUNKS
        // ========================================================

        const arrayBuffer =
            await blob.arrayBuffer();


        const bytes =
            new Uint8Array(
                arrayBuffer
            );


        const CHUNK_SIZE =
            512 * 1024;


        const chunks =
            [];


        for (
            let offset = 0;
            offset < bytes.length;
            offset += CHUNK_SIZE
        ) {

            const end =
                Math.min(
                    offset + CHUNK_SIZE,
                    bytes.length
                );


            let binary =
                "";

            for (
                let i = offset;
                i < end;
                i++
            ) {

                binary +=
                    String.fromCharCode(
                        bytes[i]
                    );
            }


            chunks.push(
                btoa(binary)
            );
        }


        console.log(
            "OFFSCREEN - Chunks:",
            chunks.length
        );


        // ========================================================
        // ENVIAR AO BACKGROUND
        // ========================================================

        chrome.runtime.sendMessage({

            target:
                "background",

            action:
                "recording-finished",

            filename:
                filename,

            chunks:
                chunks,

            sessionId:
                recordingSessionId
        });


    } catch (error) {

        console.error(
            "OFFSCREEN - ERRO AO FINALIZAR:",
            error
        );


    } finally {

        // ========================================================
        // LIBERAR STREAM
        // ========================================================

        if (stream) {

            stream
                .getTracks()
                .forEach(
                    track => {

                        try {
                            track.stop();
                        } catch (e) {}
                    }
                );

            stream = null;
        }


        // ========================================================
        // AUDIO SOURCE
        // ========================================================

        if (audioSource) {

            try {
                audioSource.disconnect();
            } catch (e) {}

            audioSource = null;
        }


        // ========================================================
        // AUDIO CONTEXT
        // ========================================================

        if (audioContext) {

            try {
                await audioContext.close();
            } catch (e) {}

            audioContext = null;
        }


        // ========================================================
        // LIMPAR
        // ========================================================

        mediaRecorder = null;

        audioChunks = [];

        recordingLessonKey = null;

        recordingSessionId = null;

        chunkSeq = 0;
    }
}
