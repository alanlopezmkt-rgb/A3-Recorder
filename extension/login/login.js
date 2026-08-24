document.addEventListener("DOMContentLoaded", () => {

    const form = document.getElementById("loginForm");
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");
    const loginButton = document.getElementById("loginButton");
    const loginError = document.getElementById("loginError");

    form.addEventListener("submit", async (event) => {

        event.preventDefault();

        loginButton.disabled = true;
        loginError.hidden = true;

        try {

            const response = await chrome.runtime.sendMessage({
                action: "login",
                email: emailInput.value.trim(),
                password: passwordInput.value
            });

            if (!response || !response.success) {
                throw new Error(response?.error || "Falha no login.");
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
