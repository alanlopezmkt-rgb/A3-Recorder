// ================================================================
// A3-OS — CLIENTE SUPABASE MINIMALISTA (fetch puro, sem bundler)
// ================================================================

const A3Supabase = (() => {

    function baseHeaders(accessToken) {
        return {
            "apikey": A3OS_CONFIG.SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${accessToken || A3OS_CONFIG.SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json"
        };
    }

    async function signIn(email, password) {
        const response = await fetch(
            `${A3OS_CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=password`,
            {
                method: "POST",
                headers: {
                    "apikey": A3OS_CONFIG.SUPABASE_ANON_KEY,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ email, password })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error_description || data.msg || "Falha no login.");
        }

        return data; // { access_token, refresh_token, expires_in, user, ... }
    }

    async function refreshSession(refreshToken) {
        const response = await fetch(
            `${A3OS_CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
            {
                method: "POST",
                headers: {
                    "apikey": A3OS_CONFIG.SUPABASE_ANON_KEY,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ refresh_token: refreshToken })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error_description || data.msg || "Falha ao renovar sessão.");
        }

        return data;
    }

    async function signOut(accessToken) {
        await fetch(`${A3OS_CONFIG.SUPABASE_URL}/auth/v1/logout`, {
            method: "POST",
            headers: baseHeaders(accessToken)
        });
    }

    async function getSession(accessToken) {
        const response = await fetch(`${A3OS_CONFIG.SUPABASE_URL}/auth/v1/user`, {
            headers: baseHeaders(accessToken)
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error_description || data.msg || "Falha ao obter sessão.");
        }

        return data; // user object if token is valid
    }

    async function restSelect(table, query, accessToken) {
        const response = await fetch(
            `${A3OS_CONFIG.SUPABASE_URL}/rest/v1/${table}?${query}`,
            { headers: baseHeaders(accessToken) }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || `Falha ao consultar ${table}.`);
        }

        return data;
    }

    async function restInsert(table, row, accessToken) {
        const response = await fetch(
            `${A3OS_CONFIG.SUPABASE_URL}/rest/v1/${table}`,
            {
                method: "POST",
                headers: {
                    ...baseHeaders(accessToken),
                    "Prefer": "return=representation"
                },
                body: JSON.stringify(row)
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || `Falha ao inserir em ${table}.`);
        }

        return Array.isArray(data) ? data[0] : data;
    }

    async function rpc(name, args, accessToken) {
        const response = await fetch(
            `${A3OS_CONFIG.SUPABASE_URL}/rest/v1/rpc/${name}`,
            {
                method: "POST",
                headers: baseHeaders(accessToken),
                body: JSON.stringify(args || {})
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || `Falha ao chamar rpc ${name}.`);
        }

        return data;
    }

    async function uploadToStorage(bucket, path, blob, accessToken) {
        // Codifica cada segmento do path (mas não as barras) para que
        // caracteres especiais em URL (#, %, etc.) não quebrem a requisição.
        const encodedPath = path
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");

        const response = await fetch(
            `${A3OS_CONFIG.SUPABASE_URL}/storage/v1/object/${bucket}/${encodedPath}`,
            {
                method: "POST",
                headers: {
                    "apikey": A3OS_CONFIG.SUPABASE_ANON_KEY,
                    "Authorization": `Bearer ${accessToken}`,
                    "Content-Type": blob.type || "application/octet-stream"
                },
                body: blob
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "Falha no upload do áudio.");
        }

        return data;
    }

    return {
        signIn,
        signOut,
        getSession,
        refreshSession,
        restSelect,
        restInsert,
        rpc,
        uploadToStorage
    };

})();

globalThis.A3Supabase = A3Supabase;
