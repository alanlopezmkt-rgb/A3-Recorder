// extension/lib/recording-backup-db.js
//
// Backup local de curto prazo dos pedaços de áudio (~30s cada) da
// gravação ativa. Vive no mesmo IndexedDB tanto para o offscreen
// document (que escreve) quanto para o service worker (que lê/apaga
// na reconciliação) — ambos rodam na mesma origem chrome-extension://.

const A3_BACKUP_DB_NAME = "a3os-recording-backup";
const A3_BACKUP_DB_VERSION = 1;
const A3_BACKUP_STORE_NAME = "chunks";

function a3AbrirBackupDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(A3_BACKUP_DB_NAME, A3_BACKUP_DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(A3_BACKUP_STORE_NAME)) {
                const store = db.createObjectStore(A3_BACKUP_STORE_NAME, {
                    keyPath: "id",
                    autoIncrement: true
                });
                store.createIndex("bySessionId", "sessionId", { unique: false });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function addChunk({ lessonKey, sessionId, seq, blob }) {
    const db = await a3AbrirBackupDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(A3_BACKUP_STORE_NAME, "readwrite");
        tx.objectStore(A3_BACKUP_STORE_NAME).add({
            lessonKey,
            sessionId,
            seq,
            blob,
            createdAt: Date.now()
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getChunksBySession(sessionId) {
    const db = await a3AbrirBackupDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(A3_BACKUP_STORE_NAME, "readonly");
        const request = tx.objectStore(A3_BACKUP_STORE_NAME).index("bySessionId").getAll(sessionId);
        request.onsuccess = () => {
            const rows = request.result || [];
            rows.sort((a, b) => a.seq - b.seq);
            resolve(rows);
        };
        request.onerror = () => reject(request.error);
    });
}

async function deleteChunksBySession(sessionId) {
    const db = await a3AbrirBackupDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(A3_BACKUP_STORE_NAME, "readwrite");
        const cursorRequest = tx
            .objectStore(A3_BACKUP_STORE_NAME)
            .index("bySessionId")
            .openCursor(IDBKeyRange.only(sessionId));

        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

self.A3RecordingBackupDb = { addChunk, getChunksBySession, deleteChunksBySession };
