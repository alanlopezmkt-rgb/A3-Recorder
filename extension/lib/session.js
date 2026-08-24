// ================================================================
// A3-OS — SESSÃO (chrome.storage.local, sobrevive a reinícios)
// ================================================================

const A3Session = (() => {

    const STORAGE_KEY = "a3os_session";

    async function saveSession(data) {
        await chrome.storage.local.set({
            [STORAGE_KEY]: {
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                expires_at: Date.now() + (data.expires_in * 1000),
                user: {
                    id: data.user.id,
                    email: data.user.email
                }
            }
        });
    }

    async function loadRawSession() {
        const stored = await chrome.storage.local.get([STORAGE_KEY]);
        return stored[STORAGE_KEY] || null;
    }

    async function login(email, password) {
        const data = await A3Supabase.signIn(email, password);
        await saveSession(data);
        return { id: data.user.id, email: data.user.email };
    }

    async function logout() {
        const session = await loadRawSession();

        if (session) {
            try {
                await A3Supabase.signOut(session.access_token);
            } catch (error) {
                console.warn("A3-OS: erro ao encerrar sessão no servidor:", error);
            }
        }

        await chrome.storage.local.remove([STORAGE_KEY]);
    }

    async function getValidAccessToken() {
        const session = await loadRawSession();

        if (!session) {
            return null;
        }

        const EXPIRY_MARGIN_MS = 60 * 1000;

        if (Date.now() < session.expires_at - EXPIRY_MARGIN_MS) {
            return session.access_token;
        }

        try {
            const refreshed = await A3Supabase.refreshSession(session.refresh_token);
            await saveSession(refreshed);
            return refreshed.access_token;
        } catch (error) {
            console.warn("A3-OS: sessão expirada, é necessário login novamente:", error);
            await chrome.storage.local.remove([STORAGE_KEY]);
            return null;
        }
    }

    async function getCurrentUser() {
        const session = await loadRawSession();
        return session ? session.user : null;
    }

    return {
        login,
        logout,
        getValidAccessToken,
        getCurrentUser
    };

})();
