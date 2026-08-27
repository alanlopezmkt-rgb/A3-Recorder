const REMEMBER_KEY = "a3os_remember_me";

document.addEventListener("DOMContentLoaded", async () => {

    const form = document.getElementById("loginForm");
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");
    const rememberInput = document.getElementById("rememberMe");
    const loginButton = document.getElementById("loginButton");
    const loginError = document.getElementById("loginError");

    try {

        const stored = await chrome.storage.local.get([REMEMBER_KEY]);
        const remembered = stored[REMEMBER_KEY];

        if (remembered) {
            emailInput.value = remembered.email || "";
            passwordInput.value = remembered.password || "";
            rememberInput.checked = true;
        }

    } catch (error) {

        console.warn("A3-OS: erro ao carregar login lembrado:", error);
    }

    form.addEventListener("submit", async (event) => {

        event.preventDefault();

        loginButton.disabled = true;
        loginError.hidden = true;

        try {

            const email = emailInput.value.trim();
            const password = passwordInput.value;

            const response = await chrome.runtime.sendMessage({
                action: "login",
                email,
                password
            });

            if (!response || !response.success) {
                throw new Error(response?.error || "Falha no login.");
            }

            if (rememberInput.checked) {
                await chrome.storage.local.set({
                    [REMEMBER_KEY]: { email, password }
                });
            } else {
                await chrome.storage.local.remove([REMEMBER_KEY]);
            }

            window.location.href = "../popup/popup.html";

        } catch (error) {

            loginError.textContent = error.message;
            loginError.hidden = false;

        } finally {

            loginButton.disabled = false;
        }
    });
});
