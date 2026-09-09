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
    // ATUALIZAÇÃO DA EXTENSÃO
    // ============================================================

    const checkUpdateButton = document.getElementById("checkUpdateButton");
    if (checkUpdateButton) {
        checkUpdateButton.addEventListener("click", verificarAtualizacaoExtensao);
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
    const historyFilters = document.getElementById("historyFilters");
    const historyDatePicker = document.getElementById("historyDatePicker");

    if (historyToggle && historyList) {

        historyToggle.addEventListener("click", () => {

            const expandido =
                historyToggle.getAttribute("aria-expanded") === "true";

            historyToggle.setAttribute("aria-expanded", String(!expandido));
            historyList.classList.toggle("is-collapsed", expandido);
            historyFilters?.classList.toggle("is-collapsed", expandido);
        });
    }

    if (historyFilters) {

        historyFilters.querySelectorAll(".history-filter-btn").forEach((btn) => {

            btn.addEventListener("click", () => {

                historyFilters
                    .querySelectorAll(".history-filter-btn")
                    .forEach((b) => b.classList.remove("is-active"));

                btn.classList.add("is-active");
                if (historyDatePicker) historyDatePicker.value = "";

                historyFiltroAtual = { modo: btn.dataset.range };
                carregarHistorico();
            });
        });
    }

    if (historyDatePicker) {

        historyDatePicker.addEventListener("change", () => {

            if (!historyDatePicker.value) return;

            historyFilters
                ?.querySelectorAll(".history-filter-btn")
                .forEach((b) => b.classList.remove("is-active"));

            historyFiltroAtual = { modo: "custom", data: historyDatePicker.value };
            carregarHistorico();
        });
    }

    await carregarHistorico();
    await carregarProgressoGeral();
    await carregarProgresso(moduloDetectado);

    const historyRefreshInterval = setInterval(carregarHistorico, 500);
    window.addEventListener("unload", () => clearInterval(historyRefreshInterval));


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

        if (response.grupoAberto) {
            const banner = document.getElementById("groupBanner");
            if (banner) {
                banner.textContent =
                    `Esta aula já tem ${formatarDuracao(response.grupoAberto.totalRecordedSeconds)} gravados de uma sessão ` +
                    `anterior. Esta gravação vai continuar a partir daí — ao terminar, os pedaços serão unidos automaticamente.`;
                banner.hidden = false;
            }
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

function formatarDuracao(segundos) {
    const min = Math.floor(segundos / 60);
    const seg = Math.round(segundos % 60);
    return `${min}min ${seg}s`;
}

async function checarDuracaoAntesDeParar() {
    // Retorna true se pode seguir com o "Parar" direto (sem aviso),
    // false se abriu o modal (o próprio modal decide o próximo passo).

    const tituloAula = document.getElementById("title")?.textContent || "aula";
    const moduleName = moduloDetectado;

    let duracaoResp, elapsedResp;
    try {
        [duracaoResp, elapsedResp] = await Promise.all([
            chrome.runtime.sendMessage({ action: "get-expected-duration", title: tituloAula, moduleName }),
            chrome.runtime.sendMessage({ action: "get-elapsed-seconds" })
        ]);
    } catch (erro) {
        console.error("Falha ao consultar duração esperada/decorrida antes de parar:", erro);
        return true; // falha de mensageria — segue direto (fail-open)
    }

    const expectedDurationSeconds = duracaoResp && duracaoResp.expectedDurationSeconds;
    const elapsedSeconds = elapsedResp && elapsedResp.elapsedSeconds;

    if (!expectedDurationSeconds || !elapsedSeconds) {
        return true; // sem dado de referência — segue direto (fail-open)
    }

    if (elapsedSeconds >= expectedDurationSeconds * 0.95) {
        return true;
    }

    mostrarModalDuracao(elapsedSeconds, expectedDurationSeconds);
    return false;
}

function mostrarModalDuracao(elapsedSeconds, expectedDurationSeconds) {
    const modal = document.getElementById("durationWarningModal");
    const texto = document.getElementById("durationWarningText");
    const btnContinuar = document.getElementById("durationWarningContinue");
    const btnPararMesmoAssim = document.getElementById("durationWarningStopAnyway");

    texto.textContent =
        `Você gravou ${formatarDuracao(elapsedSeconds)}. Essa aula costuma durar cerca de ${formatarDuracao(expectedDurationSeconds)}.`;

    modal.hidden = false;

    const fechar = () => { modal.hidden = true; };

    btnContinuar.onclick = fechar;

    btnPararMesmoAssim.onclick = async () => {
        const restante = expectedDurationSeconds - elapsedSeconds;
        texto.textContent =
            `Ok, gravamos ${formatarDuracao(elapsedSeconds)} dessa aula e vamos guardar. ` +
            `Grave essa aula de novo quando puder para completar os outros ~${formatarDuracao(restante)}.`;
        btnContinuar.hidden = true;
        btnPararMesmoAssim.hidden = true;

        await executarParada(true);

        setTimeout(() => {
            fechar();
            btnContinuar.hidden = false;
            btnPararMesmoAssim.hidden = false;
        }, 2500);
    };
}

async function pararGravacao() {
    const podeSeguir = await checarDuracaoAntesDeParar();
    if (!podeSeguir) {
        return; // modal está no ar; o próprio modal decide o próximo passo
    }
    await executarParada(false);
}

async function executarParada(duracaoConfirmadaIncompleta) {

    const statusTextElement =
        document.getElementById("statusText");

    try {

        const response =
            await chrome.runtime.sendMessage({

                action: "stop-recording",

                duracaoConfirmadaIncompleta
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

            statusTextElement.textContent = duracaoConfirmadaIncompleta
                ? "Processando áudio (gravação parcial salva)..."
                : "Processando áudio...";
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

    const groupBanner =
        document.getElementById(
            "groupBanner"
        );

    if (groupBanner) {
        groupBanner.hidden = true;
        groupBanner.textContent = "";
    }

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
    uploaded: "Pendente de transcrição",
    processing: "Transcrevendo",
    synced: "Na base de conhecimento",
    unsynced: "Transcrito, mas não sincronizado",
    failed: "Falhou",
    suspeita: "Gravação incompleta",
    longa: "Possível pausa na gravação"
};

// Filtro de data ativo no histórico ({ modo: "all" }, "today", "yesterday",
// "week", ou { modo: "custom", data: "YYYY-MM-DD" }). "all" preserva o
// comportamento original (últimos 20 envios, sem filtro de data).
let historyFiltroAtual = { modo: "all" };

function inicioDoDia(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function calcularIntervaloHistorico(filtro) {

    const hoje = inicioDoDia(new Date());

    if (filtro.modo === "today") {
        const fim = new Date(hoje);
        fim.setDate(fim.getDate() + 1);
        return { startDate: hoje.toISOString(), endDate: fim.toISOString() };
    }

    if (filtro.modo === "yesterday") {
        const inicio = new Date(hoje);
        inicio.setDate(inicio.getDate() - 1);
        return { startDate: inicio.toISOString(), endDate: hoje.toISOString() };
    }

    if (filtro.modo === "week") {
        const inicio = new Date(hoje);
        inicio.setDate(inicio.getDate() - 7);
        const fim = new Date(hoje);
        fim.setDate(fim.getDate() + 1);
        return { startDate: inicio.toISOString(), endDate: fim.toISOString() };
    }

    if (filtro.modo === "custom" && filtro.data) {
        const inicio = inicioDoDia(`${filtro.data}T00:00:00`);
        const fim = new Date(inicio);
        fim.setDate(fim.getDate() + 1);
        return { startDate: inicio.toISOString(), endDate: fim.toISOString() };
    }

    return null;
}

function statusEfetivo(item) {

    // Duração real bem diferente da esperada pra essa aula — prevalece
    // sobre o status de sincronização, já que é o aviso mais importante
    // pra quem enviou. "curta" (cortada) é mais grave que "longa" (pausada
    // no meio, mas o áudio existe inteiro), por isso tem status dedicado.
    if (item.duracao_suspeita) {
        return item.duracao_tipo === "longa" ? "longa" : "suspeita";
    }

    if (item.status === "uploaded" || item.status === "processing" || item.status === "failed") {
        return item.status;
    }

    if (item.status !== "completed") {
        return item.status;
    }

    const syncRows = item.knowledge_sync_status || [];

    const ultimoSync = syncRows
        .slice()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    return ultimoSync?.status === "synced" ? "synced" : "unsynced";
}

async function carregarHistorico() {

    const listElement = document.getElementById("historyList");

    if (!listElement) {
        return;
    }

    try {

        const intervalo = calcularIntervaloHistorico(historyFiltroAtual);

        const response =
            await chrome.runtime.sendMessage({
                action: "get-upload-history",
                ...(intervalo || {})
            });

        atualizarStatusBanco(!response?.error);

        const history = response?.history || [];

        if (history.length === 0) {

            const mensagem = intervalo
                ? "Nenhuma aula enviada nesse período."
                : "Nenhuma aula enviada ainda.";

            listElement.innerHTML = `<div class="history-empty">${mensagem}</div>`;

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

    const statusChave = statusEfetivo(item);

    const statusLabel =
        HISTORY_STATUS_LABEL[statusChave] || statusChave;

    const avisoSuspeita = !item.duracao_suspeita
        ? ""
        : item.duracao_tipo === "longa"
            ? `<div class="history-item-warning history-item-warning-longa">⚠ Gravação mais longa que o esperado: ficou com ${formatarMinutos(item.duration)}, mas essa aula costuma ter ${formatarMinutos(item.duracao_esperada_segundos)}. Provavelmente ficou pausada no meio — o áudio deve estar completo, mas confira se não tem um trecho grande de silêncio antes de gerar o resumo.</div>`
            : `<div class="history-item-warning">⚠ Minutagem da gravação incorreta: ficou com ${formatarMinutos(item.duration)}, mas essa aula tem ${formatarMinutos(item.duracao_esperada_segundos)} de duração real. Grave de novo.</div>`;

    return `
        <div class="history-item">
            <div class="history-item-title">${escapeHtml(titulo)}</div>
            ${meta ? `<div class="history-item-meta">${escapeHtml(meta)}</div>` : ""}
            <div class="history-item-date">
                <span>${dataFormatada}</span>
                <span class="history-item-status status-${statusChave}">${escapeHtml(statusLabel)}</span>
            </div>
            ${avisoSuspeita}
        </div>
    `;
}

function formatarMinutos(segundos) {

    if (!segundos && segundos !== 0) {
        return "—";
    }

    const totalSegundos = Math.round(Number(segundos));
    const minutos = Math.floor(totalSegundos / 60);
    const restoSegundos = totalSegundos % 60;

    return `${minutos}min ${String(restoSegundos).padStart(2, "0")}s`;
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

// ================================================================
// ATUALIZAÇÃO DA EXTENSÃO
//
// O Chrome não deixa uma extensão "Carregar sem compactação" (modo
// desenvolvedor) se auto-instalar — só extensões da Chrome Web Store ou
// forçadas por política de empresa fazem isso. O melhor que dá pra fazer
// aqui é: checar a versão mais nova no GitHub Releases, baixar o .zip
// automaticamente se houver uma nova, e mostrar um passo a passo curto
// pra recarregar a extensão manualmente.
// ================================================================

const A3OS_RECORDER_REPO = "alanlopezmkt-rgb/A3-Recorder";

function compararVersoes(a, b) {
    const partesA = a.split(".").map(Number);
    const partesB = b.split(".").map(Number);
    const tamanho = Math.max(partesA.length, partesB.length);

    for (let i = 0; i < tamanho; i++) {
        const numA = partesA[i] || 0;
        const numB = partesB[i] || 0;
        if (numA !== numB) return numA - numB;
    }

    return 0;
}

async function verificarAtualizacaoExtensao() {

    const updateStatus = document.getElementById("updateStatus");
    const checkUpdateButton = document.getElementById("checkUpdateButton");

    if (checkUpdateButton) checkUpdateButton.disabled = true;
    if (updateStatus) {
        updateStatus.className = "update-status";
        updateStatus.textContent = "Verificando...";
    }

    try {
        const versaoAtual = chrome.runtime.getManifest().version;

        const resposta = await fetch(`https://api.github.com/repos/${A3OS_RECORDER_REPO}/releases/latest`);
        if (!resposta.ok) {
            throw new Error(`GitHub respondeu ${resposta.status}`);
        }

        const release = await resposta.json();
        const versaoMaisNova = String(release.tag_name || "").replace(/^v/i, "");

        if (!versaoMaisNova || compararVersoes(versaoMaisNova, versaoAtual) <= 0) {
            if (updateStatus) {
                updateStatus.classList.add("is-ok");
                updateStatus.textContent = `Você já está na versão mais recente (${versaoAtual}).`;
            }
            return;
        }

        const asset = (release.assets || []).find((a) => a.name.endsWith(".zip"));
        if (!asset) {
            throw new Error("Release novo encontrado, mas sem arquivo .zip anexado.");
        }

        if (updateStatus) {
            updateStatus.textContent = `Baixando versão ${versaoMaisNova}...`;
        }

        await chrome.downloads.download({
            url: asset.browser_download_url,
            filename: `A3-OS-Recorder-${versaoMaisNova}.zip`,
            saveAs: false,
        });

        if (updateStatus) {
            updateStatus.classList.add("is-ok");
            updateStatus.innerHTML =
                `Nova versão <strong>${versaoMaisNova}</strong> baixada! Pra instalar:` +
                `<ol>` +
                `<li>Descompacte o .zip baixado</li>` +
                `<li>Abra <strong>chrome://extensions</strong></li>` +
                `<li>Clique em atualizar (⟳) na extensão ou remova e carregue a pasta nova</li>` +
                `</ol>`;
        }

    } catch (error) {
        if (updateStatus) {
            updateStatus.classList.add("is-error");
            updateStatus.textContent = `Não foi possível verificar: ${error.message}`;
        }
    } finally {
        if (checkUpdateButton) checkUpdateButton.disabled = false;
    }
}
