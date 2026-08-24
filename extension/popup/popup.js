let recording = false;

document.addEventListener("DOMContentLoaded", async () => {

    const userCheck = await chrome.runtime.sendMessage({ action: "get-current-user" });

    if (!userCheck || !userCheck.user) {
        window.location.href = "../login/login.html";
        return;
    }

    const userEmailElement = document.getElementById("userEmail");
    if (userEmailElement) {
        userEmailElement.textContent = userCheck.user.email;
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
    // CURSO / MODULO / AULA
    // ============================================================

    await carregarCursosEModulos();


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
                        statusTextElement.textContent = "Enviando áudio para o Supabase...";
                    }

                    if (message.stage === "done") {
                        mostrarSucessoSupabase();
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
// CURSO / MODULO / AULA
// ================================================================

async function carregarCursosEModulos() {

    const courseSelect = document.getElementById("courseSelect");
    const moduleSelect = document.getElementById("moduleSelect");
    const lessonNumberInput = document.getElementById("lessonNumberInput");

    if (!courseSelect || !moduleSelect || !lessonNumberInput) {
        return;
    }

    const coursesResponse = await chrome.runtime.sendMessage({ action: "get-courses" });

    courseSelect.innerHTML = "";

    (coursesResponse.courses || []).forEach(course => {
        const option = document.createElement("option");
        option.value = course.id;
        option.textContent = course.name;
        courseSelect.appendChild(option);
    });

    const saved = await chrome.storage.local.get([
        "selectedCourseId",
        "selectedModuleId",
        "selectedLessonNumber"
    ]);

    if (saved.selectedCourseId) {
        courseSelect.value = saved.selectedCourseId;
    }

    async function carregarModulos() {

        const modulesResponse = await chrome.runtime.sendMessage({
            action: "get-modules",
            courseId: courseSelect.value
        });

        moduleSelect.innerHTML = "";

        (modulesResponse.modules || []).forEach(mod => {
            const option = document.createElement("option");
            option.value = mod.id;
            option.textContent = `${mod.module_number} — ${mod.name}`;
            moduleSelect.appendChild(option);
        });

        if (saved.selectedModuleId) {
            moduleSelect.value = saved.selectedModuleId;
        }

        await chrome.storage.local.set({ selectedCourseId: courseSelect.value });
    }

    await carregarModulos();

    if (saved.selectedLessonNumber) {
        lessonNumberInput.value = saved.selectedLessonNumber;
    }

    courseSelect.addEventListener("change", carregarModulos);

    moduleSelect.addEventListener("change", async () => {
        await chrome.storage.local.set({ selectedModuleId: moduleSelect.value });
    });

    lessonNumberInput.addEventListener("change", async () => {
        await chrome.storage.local.set({ selectedLessonNumber: lessonNumberInput.value });
    });
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
            "Aula enviada com sucesso para o Supabase!";
    }

    setTimeout(() => {

        if (status) {

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
