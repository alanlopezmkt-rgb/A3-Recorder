let recording = false;

document.addEventListener("DOMContentLoaded", async () => {

    const titleElement = document.getElementById("title");
    const statusElement = document.getElementById("status");
    const statusTextElement = document.getElementById("statusText");
    const folderElement = document.getElementById("folder");
    const recordButton = document.getElementById("recordButton");
    const themeToggle = document.getElementById("themeToggle");

    // ============================================================
    // TEMA (claro / escuro)
    // ============================================================

    await carregarTema();

    if (themeToggle) {

        themeToggle.addEventListener(
            "click",
            alternarTema
        );
    }


    // ============================================================
    // DETECTAR TÍTULO DA AULA
    // ============================================================

    try {

        const tabs = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        const tab = tabs[0];

        if (!tab) {

            titleElement.textContent = "Nenhuma aba encontrada.";

        } else {

            try {

                const result = await chrome.scripting.executeScript({

                    target: {
                        tabId: tab.id
                    },

                    func: () => {

                        const h1 = document.querySelector("h1");

                        if (
                            h1 &&
                            h1.innerText &&
                            h1.innerText.trim()
                        ) {
                            return h1.innerText.trim();
                        }

                        return document.title || "Aula sem título";
                    }
                });

                titleElement.textContent =
                    result?.[0]?.result || "Aula sem título";

            } catch (error) {

                console.warn(
                    "Não foi possível detectar o título:",
                    error
                );

                titleElement.textContent =
                    tab.title || "Aula sem título";
            }
        }

    } catch (error) {

        console.error(
            "Erro ao detectar aula:",
            error
        );

        titleElement.textContent =
            "Aula sem título";
    }


    // ============================================================
    // CARREGAR PASTA
    // ============================================================

    await carregarPasta();


    // ============================================================
    // STATUS DA GRAVAÇÃO
    // ============================================================

    try {

        const response =
            await chrome.runtime.sendMessage({
                action: "get-recording-status"
            });

        if (response) {

            recording = !!response.recording;

            if (recording) {
                atualizarInterfaceGravando();
            } else {
                atualizarInterfaceParado();
            }
        }

    } catch (error) {

        console.error(
            "Erro ao consultar status:",
            error
        );
    }


    // ============================================================
    // BOTÃO GRAVAR / PARAR
    // ============================================================

    if (recordButton) {

        recordButton.addEventListener(
            "click",
            async () => {

                recordButton.disabled = true;

                try {

                    if (!recording) {

                        await iniciarGravacao();

                    } else {

                        await pararGravacao();
                    }

                } finally {

                    setTimeout(() => {
                        recordButton.disabled = false;
                    }, 500);
                }
            }
        );
    }


    // ============================================================
    // SELECIONAR PASTA
    // ============================================================

    if (folderElement) {

        folderElement.addEventListener(
            "click",
            selecionarPasta
        );

        folderElement.addEventListener(
            "keydown",
            (event) => {

                if (
                    event.key === "Enter" ||
                    event.key === " "
                ) {

                    event.preventDefault();

                    selecionarPasta();
                }
            }
        );
    }


    // ============================================================
    // ESCUTAR ATUALIZAÇÕES
    // ============================================================

    chrome.runtime.onMessage.addListener(
        (message) => {

            if (
                message.action ===
                "download-success"
            ) {

                mostrarSucessoDownload(
                    message.filename
                );
            }


            if (
                message.action ===
                "download-error"
            ) {

                mostrarErro(
                    message.error
                );
            }


            if (
                message.action ===
                "recording-state"
            ) {

                recording =
                    !!message.recording;

                if (recording) {

                    atualizarInterfaceGravando();

                } else {

                    atualizarInterfaceParado();
                }
            }
        }
    );

});


// ================================================================
// TEMA (claro / escuro)
// ================================================================

async function carregarTema() {

    try {

        const saved =
            await chrome.storage.local.get(
                ["theme"]
            );

        const tema =
            saved.theme === "light" ?
                "light" :
                "dark";

        document.documentElement.setAttribute(
            "data-theme",
            tema
        );

    } catch (error) {

        console.error(
            "Erro ao carregar tema:",
            error
        );
    }
}


async function alternarTema() {

    const atual =
        document.documentElement.getAttribute(
            "data-theme"
        );

    const novo =
        atual === "light" ?
            "dark" :
            "light";

    document.documentElement.setAttribute(
        "data-theme",
        novo
    );

    try {

        await chrome.storage.local.set({
            theme: novo
        });

    } catch (error) {

        console.error(
            "Erro ao salvar tema:",
            error
        );
    }
}


// ================================================================
// CARREGAR PASTA
// ================================================================

async function carregarPasta() {

    const folderPathElement =
        document.getElementById("folderPath");

    if (!folderPathElement) {
        return;
    }

    try {

        const saved =
            await chrome.storage.local.get(
                ["outputFolder"]
            );

        if (
            saved.outputFolder &&
            saved.outputFolder.trim()
        ) {

            folderPathElement.textContent =
                saved.outputFolder;

        } else {

            folderPathElement.textContent =
                "Clique para selecionar a pasta";
        }

    } catch (error) {

        console.error(
            "Erro ao carregar pasta:",
            error
        );

        folderPathElement.textContent =
            "Clique para selecionar a pasta";
    }
}


// ================================================================
// SELECIONAR PASTA WINDOWS
// ================================================================

async function selecionarPasta() {

    const folderPathElement =
        document.getElementById("folderPath");

    const statusTextElement =
        document.getElementById("statusText");

    if (folderPathElement) {

        folderPathElement.textContent =
            "Abrindo seletor de pasta...";
    }

    try {

        const response =
            await chrome.runtime.sendMessage({
                action: "select-folder"
            });

        console.log(
            "Resposta seleção:",
            response
        );

        if (
            response &&
            response.success &&
            response.folder
        ) {

            if (folderPathElement) {

                folderPathElement.textContent =
                    response.folder;
            }

            if (statusTextElement) {

                statusTextElement.textContent =
                    "Pasta configurada";
            }

        } else {

            await carregarPasta();

            if (statusTextElement) {

                statusTextElement.textContent =
                    "Aula detectada";
            }
        }

    } catch (error) {

        console.error(
            "Erro ao selecionar pasta:",
            error
        );

        await carregarPasta();

        if (statusTextElement) {

            statusTextElement.textContent =
                "Erro ao selecionar pasta";
        }
    }
}


// ================================================================
// INICIAR
// ================================================================

async function iniciarGravacao() {

    const titleElement =
        document.getElementById("title");

    const statusTextElement =
        document.getElementById("statusText");

    try {

        const saved =
            await chrome.storage.local.get(
                ["outputFolder"]
            );

        if (
            !saved.outputFolder ||
            !saved.outputFolder.trim()
        ) {

            if (statusTextElement) {

                statusTextElement.textContent =
                    "Selecione uma pasta antes de gravar.";
            }

            return;
        }


        const title =
            titleElement?.textContent ||
            "aula";


        const response =
            await chrome.runtime.sendMessage({

                action: "start-recording",

                title: title,

                outputFolder:
                    saved.outputFolder
            });


        console.log(
            "Resposta início:",
            response
        );


        if (
            !response ||
            response.success === false
        ) {

            console.error(
                "Erro ao iniciar:",
                response?.error
            );

            mostrarErro(
                response?.error ||
                "Erro ao iniciar gravação"
            );

            return;
        }


        recording = true;

        atualizarInterfaceGravando();

    } catch (error) {

        console.error(
            "Erro ao iniciar gravação:",
            error
        );

        mostrarErro(
            "Erro ao iniciar gravação"
        );
    }
}


// ================================================================
// PARAR
// ================================================================

async function pararGravacao() {

    const statusTextElement =
        document.getElementById("statusText");

    try {

        const response =
            await chrome.runtime.sendMessage({

                action: "stop-recording"
            });


        console.log(
            "Resposta parada:",
            response
        );


        if (
            !response ||
            response.success === false
        ) {

            console.error(
                "Erro ao parar:",
                response?.error
            );

            return;
        }


        recording = false;

        atualizarInterfaceParado();


        if (statusTextElement) {

            statusTextElement.textContent =
                "Processando áudio...";
        }

    } catch (error) {

        console.error(
            "Erro ao parar gravação:",
            error
        );
    }
}


// ================================================================
// INTERFACE GRAVANDO
// ================================================================

function atualizarInterfaceGravando() {

    const button =
        document.getElementById(
            "recordButton"
        );

    const status =
        document.getElementById(
            "status"
        );

    const statusText =
        document.getElementById(
            "statusText"
        );

    const recordLabel =
        document.getElementById(
            "recordLabel"
        );

    const brandIcon =
        document.getElementById(
            "brandIcon"
        );


    if (button) {

        button.classList.add(
            "recording"
        );
    }

    if (recordLabel) {

        recordLabel.textContent =
            "PARAR GRAVAÇÃO";
    }


    if (status) {

        status.classList.remove(
            "is-success",
            "is-error"
        );

        status.classList.add(
            "is-recording"
        );
    }

    if (statusText) {

        statusText.textContent =
            "Gravando áudio da aba";
    }


    if (brandIcon) {

        brandIcon.src =
            "../icons/icon-recording-48.png";
    }
}


// ================================================================
// INTERFACE PARADO
// ================================================================

function atualizarInterfaceParado() {

    const button =
        document.getElementById(
            "recordButton"
        );

    const status =
        document.getElementById(
            "status"
        );

    const statusText =
        document.getElementById(
            "statusText"
        );

    const recordLabel =
        document.getElementById(
            "recordLabel"
        );

    const brandIcon =
        document.getElementById(
            "brandIcon"
        );


    if (button) {

        button.classList.remove(
            "recording"
        );
    }

    if (recordLabel) {

        recordLabel.textContent =
            "GRAVAR";
    }


    if (status) {

        status.classList.remove(
            "is-recording",
            "is-error"
        );
    }

    if (statusText) {

        statusText.textContent =
            "Aula detectada";
    }


    if (brandIcon) {

        brandIcon.src =
            "../icons/icon-normal-48.png";
    }
}


// ================================================================
// SUCESSO
// ================================================================

function mostrarSucessoDownload(
    filename
) {

    const status =
        document.getElementById(
            "status"
        );

    const statusText =
        document.getElementById(
            "statusText"
        );

    if (status) {

        status.classList.remove(
            "is-recording",
            "is-error"
        );

        status.classList.add(
            "is-success"
        );
    }

    if (statusText) {

        statusText.textContent =
            "Áudio salvo com sucesso!";
    }

    setTimeout(() => {

        if (status) {

            status.classList.remove(
                "is-success"
            );
        }

        if (statusText) {

            statusText.textContent =
                "Aula detectada";
        }

    }, 5000);


    console.log(
        "Áudio salvo:",
        filename
    );
}


// ================================================================
// ERRO
// ================================================================

function mostrarErro(
    mensagem
) {

    const status =
        document.getElementById(
            "status"
        );

    const statusText =
        document.getElementById(
            "statusText"
        );

    if (status) {

        status.classList.remove(
            "is-recording",
            "is-success"
        );

        status.classList.add(
            "is-error"
        );
    }

    if (statusText) {

        statusText.textContent =
            mensagem ||
            "Ocorreu um erro.";
    }
}
