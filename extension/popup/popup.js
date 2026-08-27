let recording = false;
let moduloDetectado = null;

function saudacaoDoDia() {

    const hora = new Date().getHours();

    if (hora < 12) {
        return "Bom dia";
    }

    if (hora < 18) {
        return "Boa tarde";
    }

    return "Boa noite";
}

document.addEventListener("DOMContentLoaded", async () => {

    const userCheck = await chrome.runtime.sendMessage({ action: "get-current-user" });

    if (!userCheck || !userCheck.user) {
        window.location.href = "../login/login.html";
        return;
    }

    const userGreetingElement = document.getElementById("userGreeting");
    if (userGreetingElement) {
        const nome = userCheck.user.displayName || userCheck.user.email;
        userGreetingElement.textContent = `${saudacaoDoDia()}, ${nome}`;
    }

    const logoutButton = document.getElementById("logoutButton");
    if (logoutButton) {
        logoutButton.addEventListener("click", async () => {
            await chrome.runtime.sendMessage({ action: "logout" });
            window.location.href = "../login/login.html";
        });
    }

    const titleElement = document.getElementById("title");
    const statusElement = document.getElementById("status");
    const statusTextElement = document.getElementById("statusText");
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

                        const title =
                            h1 && h1.innerText && h1.innerText.trim()
                                ? h1.innerText.trim()
                                : (document.title || "Aula sem título");

                        // A pagina tem varios elementos com ".text-foreground" (ex: botao
                        // "Voltar" no topo). O nome do modulo e' o texto imediatamente
                        // acima do h1 da aula, entao pegamos o ultimo candidato que
                        // aparece ANTES do h1 no DOM, ignorando textos de navegacao
                        // genericos como "Voltar".
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

                const deteccao = result?.[0]?.result;

                titleElement.textContent = deteccao?.title || "Aula sem título";
                moduloDetectado = deteccao?.moduleName || null;

                const moduleTitleElement = document.getElementById("moduleTitle");
                if (moduleTitleElement) {
                    moduleTitleElement.textContent = moduloDetectado || "Módulo não detectado";
                }

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
    // HISTÓRICO DE ENVIOS
    // ============================================================

    const historyToggle = document.getElementById("historyToggle");
    const historyList = document.getElementById("historyList");

    if (historyToggle && historyList) {

        historyToggle.addEventListener("click", () => {

            const expandido =
                historyToggle.getAttribute("aria-expanded") === "true";

            historyToggle.setAttribute("aria-expanded", String(!expandido));
            historyList.classList.toggle("is-collapsed", expandido);
        });
    }

    await carregarHistorico();
    await carregarProgressoGeral();
    await carregarProgresso(moduloDetectado);


    // ============================================================
    // ESCUTAR ATUALIZAÇÕES
    // ============================================================

    chrome.runtime.onMessage.addListener(
        (message) => {

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


            if (message.action === "upload-status") {

                const statusTextElement = document.getElementById("statusText");

                if (statusTextElement) {

                    if (message.stage === "uploading") {
                        const statusElement = document.getElementById("status");
                        if (statusElement) {
                            statusElement.hidden = false;
                        }
                        statusTextElement.textContent = "Enviando áudio...";
                    }

                    if (message.stage === "done") {
                        mostrarSucessoSupabase();
                        carregarHistorico();
                        carregarProgressoGeral();
                        carregarProgresso(moduloDetectado);
                    }

                    if (message.stage === "error") {
                        mostrarErro(message.error || "Erro ao enviar áudio.");
                    }
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

        const title =
            titleElement?.textContent ||
            "aula";


        const response =
            await chrome.runtime.sendMessage({

                action: "start-recording",

                title: title,

                moduleName: moduloDetectado,

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


        const statusElement = document.getElementById("status");

        if (statusElement) {
            statusElement.hidden = false;
        }

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

        status.hidden = false;

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

        status.hidden = true;

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
// SUCESSO SUPABASE
// ================================================================

function mostrarSucessoSupabase() {

    const status =
        document.getElementById(
            "status"
        );

    const statusText =
        document.getElementById(
            "statusText"
        );

    if (status) {

        status.hidden = false;

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
            "Aula enviada com sucesso!";
    }

    setTimeout(() => {

        if (status) {

            status.hidden = true;

            status.classList.remove(
                "is-success"
            );
        }

        if (statusText) {

            statusText.textContent =
                "Aguardando transcrição.";
        }

    }, 5000);
}


// ================================================================
// CONEXÃO COM O BANCO DE DADOS
// ================================================================

function atualizarStatusBanco(conectado) {

    const dbStatus = document.getElementById("dbStatus");
    const dbStatusText = document.getElementById("dbStatusText");

    if (!dbStatus) {
        return;
    }

    dbStatus.classList.toggle("db-status-ok", conectado);
    dbStatus.classList.toggle("db-status-off", !conectado);

    if (dbStatusText) {
        dbStatusText.textContent = conectado
            ? "Conectado"
            : "Sem conexão";
    }
}


// ================================================================
// HISTÓRICO DE ENVIOS
// ================================================================

const HISTORY_STATUS_LABEL = {
    uploaded: "Enviado",
    processing: "Transcrevendo",
    completed: "Concluído",
    failed: "Falhou"
};

async function carregarHistorico() {

    const listElement = document.getElementById("historyList");

    if (!listElement) {
        return;
    }

    try {

        const response =
            await chrome.runtime.sendMessage({
                action: "get-upload-history"
            });

        atualizarStatusBanco(!response?.error);

        const history = response?.history || [];

        if (history.length === 0) {

            listElement.innerHTML =
                '<div class="history-empty">Nenhuma aula enviada ainda.</div>';

            return;
        }

        listElement.innerHTML = history
            .map(renderHistoryItem)
            .join("");

    } catch (error) {

        console.error(
            "Erro ao carregar histórico:",
            error
        );

        listElement.innerHTML =
            '<div class="history-empty">Não foi possível carregar o histórico.</div>';
    }
}

function renderHistoryItem(item) {

    const titulo = item.lessons
        ? `${item.lessons.lesson_number} — ${item.lessons.title}`
        : item.filename;

    const meta = [
        item.courses?.name,
        item.modules ? `Módulo ${item.modules.module_number}` : null
    ]
        .filter(Boolean)
        .join(" · ");

    const dataFormatada = formatarDataHora(item.created_at);

    const statusLabel =
        HISTORY_STATUS_LABEL[item.status] || item.status;

    return `
        <div class="history-item">
            <div class="history-item-title">${escapeHtml(titulo)}</div>
            ${meta ? `<div class="history-item-meta">${escapeHtml(meta)}</div>` : ""}
            <div class="history-item-date">
                <span>${dataFormatada}</span>
                <span class="history-item-status status-${item.status}">${escapeHtml(statusLabel)}</span>
            </div>
        </div>
    `;
}

function formatarDataHora(isoString) {

    if (!isoString) {
        return "—";
    }

    const data = new Date(isoString);

    if (Number.isNaN(data.getTime())) {
        return "—";
    }

    const dataParte = data.toLocaleDateString("pt-BR");
    const horaParte = data.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit"
    });

    return `${dataParte} às ${horaParte}`;
}

function escapeHtml(texto) {

    const div = document.createElement("div");
    div.textContent = texto ?? "";
    return div.innerHTML;
}


// ================================================================
// PROGRESSO GERAL DO CURSO
// ================================================================

async function carregarProgressoGeral() {

    const valueElement = document.getElementById("overallProgressValue");
    const fillElement = document.getElementById("overallProgressFill");

    if (!valueElement) {
        return;
    }

    try {

        const response = await chrome.runtime.sendMessage({ action: "get-overall-progress" });

        const progress = response?.progress;

        if (!progress) {
            return;
        }

        valueElement.textContent = `${progress.percent}%`;

        if (fillElement) {
            fillElement.style.width = `${progress.percent}%`;
        }

    } catch (error) {

        console.warn("Erro ao carregar progresso geral do curso:", error);
    }
}


// ================================================================
// PROGRESSO DO MODULO ATUAL
// ================================================================

async function carregarProgresso(moduleName) {

    const labelElement = document.getElementById("moduleProgressLabel");
    const valueElement = document.getElementById("moduleProgressValue");
    const fillElement = document.getElementById("moduleProgressFill");

    if (!labelElement || !valueElement) {
        return;
    }

    if (!moduleName) {
        labelElement.textContent = "Módulo atual";
        valueElement.textContent = "não identificado";
        if (fillElement) fillElement.style.width = "0%";
        return;
    }

    try {

        const response = await chrome.runtime.sendMessage({
            action: "get-module-progress",
            moduleName
        });

        const progress = response?.progress;

        if (!progress || !progress.found) {
            labelElement.textContent = moduleName;
            valueElement.textContent = "não cadastrado";
            if (fillElement) fillElement.style.width = "0%";
            return;
        }

        labelElement.textContent = progress.moduleName;
        valueElement.textContent = `${progress.percent}%`;

        if (fillElement) {
            fillElement.style.width = `${progress.percent}%`;
        }

    } catch (error) {

        console.warn("Erro ao carregar progresso do módulo:", error);
    }
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

        status.hidden = false;

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
