# Gravação Resiliente a Interrupções — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a lesson recording survive an abrupt Chrome/PC shutdown — losing at most ~30s of audio — and let a lesson recorded across multiple days/sessions be delivered to transcription as one continuous file.

**Architecture:** Two independent layers inside the A3-OS Recorder extension — (1) a 30s-interval IndexedDB backup of the active `MediaRecorder` session, shared between the offscreen document and the background service worker (same extension origin); (2) a lightweight "recording group" record in `chrome.storage.local` keyed by a stable `lessonKey`, that lets a resumed recording attach as the next segment of an existing group. Each segment becomes its own row in Supabase `audio_files` (`recording_group_id`, `segment_index`, `is_final`). The Python worker (`supabase_worker.py`) concatenates all segments of a group with `ffmpeg -f concat` before transcribing, only when the job's segment is `is_final = true`.

**Tech Stack:** Vanilla JS (Manifest V3 extension, no bundler), IndexedDB, `chrome.storage.local`/`chrome.alarms`, Supabase (Postgres + Storage + REST), Python worker with `ffmpeg` (already a dependency via `detectar_duracao`).

**Spec:** [`A3-Recorder-split/docs/superpowers/specs/2026-09-07-gravacao-resiliente-design.md`](../specs/2026-09-07-gravacao-resiliente-design.md)

## Global Constraints

- Chunk save interval: **30 seconds** (`mediaRecorder.start(30000)`) — user's explicit choice, not the 2-minute default originally recommended.
- Group expiry: **7 days** of inactivity (`lastActivityAt`), swept by a daily `chrome.alarms` alarm.
- `lessonKey = slugify(title + "|" + (moduleName || ""))`, computed with the same `slugify` implementation as `knowledge-tools` (copied, not imported across repos — these are separate git repositories with no shared dependency).
- The single "Parar" button never changes meaning: it always finalizes whatever is being recorded right now. A group is created/extended **only** by the reconciliation path (an interruption was detected) — never by a normal, uninterrupted "Parar". See the ruling in Task 7.
- `recording_group_id IS NULL` must behave byte-for-byte like today's single-shot upload (no regression for the common case).
- No new client-side dependency (no ffmpeg.wasm, no IndexedDB wrapper library) — everything is hand-rolled with the native `indexedDB` API to match the existing zero-dependency extension code style.
- No new test framework is introduced into the extension repo (it currently has none — matches existing convention). `knowledge-tools` already has `node --test`; new pure-logic modules destined for both repos are authored and unit-tested there first, then copied.

---

### Task 1: Supabase schema — segment columns + RPC update

**Files:**
- Supabase migration (via `mcp__d901dc82-1801-4240-8749-205f96fd2589__apply_migration`, project `kvvcbkamxalcklnyodeu`), migration name `add_recording_group_columns`.

**Interfaces:**
- Produces: `audio_files.recording_group_id uuid`, `audio_files.segment_index int`, `audio_files.is_final boolean not null default true` — consumed by Tasks 7, 8, 9, 10.
- Produces: `reserve_transcription_job(p_worker_id)` now also returns `recording_group_id` and `is_final` — consumed by Task 10.

- [ ] **Step 1: Add the three columns**

Run via `apply_migration`:

```sql
ALTER TABLE audio_files
  ADD COLUMN recording_group_id uuid,
  ADD COLUMN segment_index int,
  ADD COLUMN is_final boolean NOT NULL DEFAULT true;
```

- [ ] **Step 2: Verify the columns exist**

Run via `execute_sql`:

```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'audio_files'
  AND column_name IN ('recording_group_id', 'segment_index', 'is_final');
```

Expected: 3 rows back, `is_final` with default `true`.

- [ ] **Step 3: Update `reserve_transcription_job` to return the new fields**

Run via `apply_migration`, name `reserve_transcription_job_return_group_fields`:

```sql
CREATE OR REPLACE FUNCTION public.reserve_transcription_job(p_worker_id text)
 RETURNS TABLE(job_id uuid, audio_file_id uuid, storage_path text, filename text, lesson_id uuid, course_id uuid, attempts integer, uploaded_by uuid, module_id uuid, recording_group_id uuid, is_final boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_job_id uuid;
  v_auto boolean;
begin
  select auto_transcribe into v_auto from app_settings where id = true;

  update transcription_jobs
  set status = 'processing',
      started_at = now(),
      worker_id = p_worker_id,
      attempts = transcription_jobs.attempts + 1
  where id = (
    select tj.id
    from transcription_jobs tj
    join audio_files af on af.id = tj.audio_file_id
    left join profiles p on p.id = af.uploaded_by
    where tj.status = 'pending'
      and (coalesce(v_auto, true) or coalesce(p.auto_transcribe, false) or tj.manual_requested)
    order by tj.created_at asc
    limit 1
    for update of tj skip locked
  )
  returning id into v_job_id;

  if v_job_id is null then
    return;
  end if;

  return query
  select tj.id, af.id, af.storage_path, af.filename, af.lesson_id, af.course_id, tj.attempts,
         af.uploaded_by, af.module_id, af.recording_group_id, af.is_final
  from transcription_jobs tj
  join audio_files af on af.id = tj.audio_file_id
  where tj.id = v_job_id;
end;
$function$;
```

This is the same function body as today (`SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'reserve_transcription_job'` to confirm before replacing), with `recording_group_id, is_final` added to the `RETURNS TABLE` and the final `select` list.

- [ ] **Step 4: Verify the RPC still works**

Run via `execute_sql`:

```sql
SELECT * FROM reserve_transcription_job('plan-verification-worker') LIMIT 1;
```

Expected: no error (empty result is fine if there's no pending job — if a row comes back, confirm it has `recording_group_id` and `is_final` columns, both nullable/true respectively for existing rows). If a row was actually reserved by this test call, reset it:

```sql
UPDATE transcription_jobs SET status = 'pending', worker_id = null, started_at = null,
  attempts = attempts - 1 WHERE worker_id = 'plan-verification-worker';
```

- [ ] **Step 5: Commit** — no local files changed; note the two migration names in the SDD ledger.

---

### Task 2: `lessonKey` helper — written and unit-tested in `knowledge-tools`

**Files:**
- Create: `knowledge-tools/lib/lesson-key.js`
- Test: `knowledge-tools/test/lesson-key.test.js`

**Interfaces:**
- Produces: `slugify(text): string`, `lessonKey(title, moduleName): string` — consumed by Task 3 (copied verbatim into the extension).

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify, lessonKey } = require('../lib/lesson-key');

test('slugify lowercases, strips accents and punctuation, collapses separators', () => {
  assert.equal(slugify('Aula 07 - Grupos & Componentes'), 'aula-07-grupos-componentes');
  assert.equal(slugify('  Sketchup  2024/2025 '), 'sketchup-2024-2025');
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
});

test('lessonKey is stable for the same title+module regardless of spacing/case', () => {
  const a = lessonKey('01 - Curso Vray 6 - Apresentação', 'SKETCHUP 2024/2025');
  const b = lessonKey('  01 - Curso Vray 6 -  Apresentação  ', 'sketchup 2024/2025');
  assert.equal(a, b);
});

test('lessonKey differs when title or module differs', () => {
  const a = lessonKey('Aula 1', 'Modulo A');
  const b = lessonKey('Aula 2', 'Modulo A');
  const c = lessonKey('Aula 1', 'Modulo B');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('lessonKey tolerates a missing module name', () => {
  assert.equal(lessonKey('Aula 1', null), lessonKey('Aula 1', ''));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lesson-key.test.js` (from `knowledge-tools/`)
Expected: FAIL — `Cannot find module '../lib/lesson-key'`.

- [ ] **Step 3: Write the implementation**

```js
function slugify(text) {
    return String(text || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function lessonKey(title, moduleName) {
    return slugify(`${title || ""}|${moduleName || ""}`);
}

module.exports = { slugify, lessonKey };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lesson-key.test.js`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add lib/lesson-key.js test/lesson-key.test.js
git commit -m "feat: add lessonKey helper for cross-session recording grouping"
git push
```

---

### Task 3: Copy `lessonKey` into the extension

**Files:**
- Create: `A3-Recorder-split/extension/lib/lesson-key.js`
- Modify: `A3-Recorder-split/extension/background.js:1`
- Modify: `A3-Recorder-split/extension/offscreen/offscreen.html`

**Interfaces:**
- Consumes: the logic from Task 2 (same behavior, different export style — no `module.exports` in a service worker/page-script context).
- Produces: global `A3LessonKey.lessonKey(title, moduleName)` — consumed by Tasks 6, 7, 8.

- [ ] **Step 1: Create the browser-global version**

```js
// extension/lib/lesson-key.js
//
// Copia intencional de knowledge-tools/lib/lesson-key.js — os dois
// repositórios não compartilham dependências, então a lógica (com seus
// testes) vive lá e é copiada aqui sem alteração de comportamento.

function slugify(text) {
    return String(text || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function lessonKey(title, moduleName) {
    return slugify(`${title || ""}|${moduleName || ""}`);
}

self.A3LessonKey = { slugify, lessonKey };
```

- [ ] **Step 2: Load it in the service worker**

In `background.js:1`, change:

```js
importScripts("config.js", "lib/supabase.js", "lib/session.js");
```

to:

```js
importScripts("config.js", "lib/supabase.js", "lib/session.js", "lib/lesson-key.js");
```

- [ ] **Step 3: Load it in the offscreen document**

In `offscreen/offscreen.html`, add before the existing script tag:

```html
<script src="../lib/lesson-key.js"></script>
<script src="offscreen.js"></script>
```

- [ ] **Step 4: Verify by loading the extension**

Open `chrome://extensions`, reload A3-OS Recorder (unpacked), open the service worker's DevTools console, run `A3LessonKey.lessonKey("Aula 1", "Modulo")` — expect `"aula-1-modulo"` with no error. Open the offscreen document's DevTools (via `chrome://extensions` → "Inspect views: offscreen.html" while a recording is active, or via `chrome.offscreen` debugging) and confirm `A3LessonKey` is also defined there.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/lesson-key.js extension/background.js extension/offscreen/offscreen.html
git commit -m "feat: load shared lessonKey helper in background and offscreen"
git push
```

---

### Task 4: IndexedDB backup module

**Files:**
- Create: `A3-Recorder-split/extension/lib/recording-backup-db.js`
- Modify: `A3-Recorder-split/extension/background.js:1`
- Modify: `A3-Recorder-split/extension/offscreen/offscreen.html`

**Interfaces:**
- Produces: global `A3RecordingBackupDb` with `addChunk({ lessonKey, sessionId, seq, blob }): Promise<void>`, `getChunksBySession(sessionId): Promise<Array<{ seq, blob }>>` (sorted by `seq` ascending), `deleteChunksBySession(sessionId): Promise<void>`. Consumed by Task 6 (write path, offscreen) and Task 8 (read+delete path, background — same extension origin, same IndexedDB).

- [ ] **Step 1: Write the module**

```js
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
```

- [ ] **Step 2: Load it in background and offscreen**

`background.js:1`:

```js
importScripts("config.js", "lib/supabase.js", "lib/session.js", "lib/lesson-key.js", "lib/recording-backup-db.js");
```

`offscreen/offscreen.html`:

```html
<script src="../lib/lesson-key.js"></script>
<script src="../lib/recording-backup-db.js"></script>
<script src="offscreen.js"></script>
```

- [ ] **Step 3: Manual verification**

Reload the extension. In the offscreen document's DevTools console (see Task 3 Step 4 for how to open it):

```js
await A3RecordingBackupDb.addChunk({ lessonKey: "teste", sessionId: "s1", seq: 0, blob: new Blob(["x"]) });
await A3RecordingBackupDb.addChunk({ lessonKey: "teste", sessionId: "s1", seq: 1, blob: new Blob(["y"]) });
const rows = await A3RecordingBackupDb.getChunksBySession("s1");
console.log(rows.length, rows.map(r => r.seq)); // 2 [0, 1]
await A3RecordingBackupDb.deleteChunksBySession("s1");
console.log((await A3RecordingBackupDb.getChunksBySession("s1")).length); // 0
```

Then repeat `getChunksBySession("s1")` from the **background service worker's** DevTools console — same result, confirming the store is shared across contexts.

- [ ] **Step 4: Commit**

```bash
git add extension/lib/recording-backup-db.js extension/background.js extension/offscreen/offscreen.html
git commit -m "feat: add shared IndexedDB backup store for recording chunks"
git push
```

---

### Task 5: Recording-groups bookkeeping module

**Files:**
- Create: `A3-Recorder-split/extension/lib/recording-groups.js`
- Modify: `A3-Recorder-split/extension/background.js:1`

**Interfaces:**
- Produces: global `A3RecordingGroups` with:
  - `getGroups(): Promise<Record<lessonKey, Group>>`
  - `createGroup(lessonKey, meta: { title, outputFolder, moduleName }): Promise<Group>` — always creates a fresh group (`segmentIndex` starts at 0); caller decides whether to call this or reuse an existing one.
  - `advanceSegment(lessonKey): Promise<void>` — increments `nextSegmentIndex` and refreshes `lastActivityAt`.
  - `closeGroup(lessonKey): Promise<void>` — deletes the entry.
  - `listExpiredGroups(maxAgeMs): Promise<Array<Group & { lessonKey }>>`
  - Where `Group = { recordingGroupId, nextSegmentIndex, lastActivityAt (ISO string), title, outputFolder, moduleName }`.
- Consumed by Task 7 (create/reuse/close), Task 8 (create/advance during reconciliation), Task 9 (list/close for expiry).

- [ ] **Step 1: Write the module**

```js
// extension/lib/recording-groups.js
//
// Metadado leve (chrome.storage.local) de aulas com gravação "em
// aberto" — ou porque uma interrupção foi detectada e ainda não foi
// fechada com um "Parar" de propósito. Ver docs/superpowers/specs/
// 2026-09-07-gravacao-resiliente-design.md.

const A3_GROUPS_STORAGE_KEY = "recordingGroups";

async function getGroups() {
    const data = await chrome.storage.local.get(A3_GROUPS_STORAGE_KEY);
    return data[A3_GROUPS_STORAGE_KEY] || {};
}

async function saveGroups(groups) {
    await chrome.storage.local.set({ [A3_GROUPS_STORAGE_KEY]: groups });
}

async function createGroup(lessonKey, meta) {
    const groups = await getGroups();
    const group = {
        recordingGroupId: crypto.randomUUID(),
        nextSegmentIndex: 0,
        lastActivityAt: new Date().toISOString(),
        title: meta.title || "aula",
        outputFolder: meta.outputFolder || "",
        moduleName: meta.moduleName || null
    };
    groups[lessonKey] = group;
    await saveGroups(groups);
    return group;
}

async function advanceSegment(lessonKey) {
    const groups = await getGroups();
    const group = groups[lessonKey];
    if (!group) {
        return;
    }
    group.nextSegmentIndex += 1;
    group.lastActivityAt = new Date().toISOString();
    await saveGroups(groups);
}

async function closeGroup(lessonKey) {
    const groups = await getGroups();
    delete groups[lessonKey];
    await saveGroups(groups);
}

async function listExpiredGroups(maxAgeMs) {
    const groups = await getGroups();
    const now = Date.now();
    return Object.entries(groups)
        .filter(([, group]) => now - new Date(group.lastActivityAt).getTime() >= maxAgeMs)
        .map(([lessonKey, group]) => ({ lessonKey, ...group }));
}

self.A3RecordingGroups = {
    getGroups,
    createGroup,
    advanceSegment,
    closeGroup,
    listExpiredGroups
};
```

- [ ] **Step 2: Load it in the service worker**

`background.js:1`:

```js
importScripts("config.js", "lib/supabase.js", "lib/session.js", "lib/lesson-key.js", "lib/recording-backup-db.js", "lib/recording-groups.js");
```

(Not needed in the offscreen document — group bookkeeping is background-only.)

- [ ] **Step 3: Manual verification**

In the background service worker's DevTools console:

```js
await A3RecordingGroups.createGroup("teste", { title: "Aula X", outputFolder: "", moduleName: "Mod" });
console.log(await A3RecordingGroups.getGroups());
await A3RecordingGroups.advanceSegment("teste");
console.log((await A3RecordingGroups.getGroups())["teste"].nextSegmentIndex); // 1
await A3RecordingGroups.closeGroup("teste");
console.log(await A3RecordingGroups.getGroups()); // {}
```

- [ ] **Step 4: Commit**

```bash
git add extension/lib/recording-groups.js extension/background.js
git commit -m "feat: add recording-groups bookkeeping module"
git push
```

---

### Task 6: `offscreen.js` — 30s chunking + IndexedDB writes + chunk cleanup

**Files:**
- Modify: `A3-Recorder-split/extension/offscreen/offscreen.js`

**Interfaces:**
- Consumes: `A3RecordingBackupDb.addChunk`, `A3RecordingBackupDb.deleteChunksBySession` (Task 4).
- Consumes (new fields on the existing message): `start-recording` now carries `lessonKey` and `sessionId` in addition to `streamId`/`title`.
- Produces: `recording-finished` message now also carries `sessionId` (so `background.js` in Task 7 can key its group/backup logic on it). New message handled: `{ target: "offscreen", action: "delete-backup-chunks", sessionId }`.

- [ ] **Step 1: Track `lessonKey`/`sessionId` and a running `seq` counter**

At the top of `offscreen.js`, alongside the existing module state:

```js
let recordingTitle = "aula";
let recordingLessonKey = null;
let recordingSessionId = null;
let chunkSeq = 0;
```

- [ ] **Step 2: Accept the new fields in `start-recording`**

In the `chrome.runtime.onMessage` listener's `start-recording` branch, change the call to:

```js
iniciarGravacao(
    message.streamId,
    message.title,
    message.lessonKey,
    message.sessionId
)
```

- [ ] **Step 3: Update `iniciarGravacao`'s signature and 30s timeslice**

```js
async function iniciarGravacao(streamId, title, lessonKey, sessionId) {

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        return;
    }

    recordingTitle = title || "aula";
    recordingLessonKey = lessonKey || null;
    recordingSessionId = sessionId || null;
    chunkSeq = 0;

    audioChunks = [];

    // ... (stream capture, AudioContext, MediaRecorder options — unchanged) ...

    mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            audioChunks.push(event.data);

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

    // ... (onerror, onstop — unchanged) ...

    mediaRecorder.start(30000);

    console.log("A3-OS Recorder: captura iniciada.");
}
```

- [ ] **Step 4: Send `sessionId` along with the finished recording**

In `finalizarGravacao`, in the `chrome.runtime.sendMessage` call at the end:

```js
chrome.runtime.sendMessage({
    target: "background",
    action: "recording-finished",
    filename: filename,
    chunks: chunks,
    sessionId: recordingSessionId
});
```

- [ ] **Step 5: Reset the new state in the `finally` block**

In `finalizarGravacao`'s `finally`, alongside `mediaRecorder = null; audioChunks = [];`, add:

```js
recordingLessonKey = null;
recordingSessionId = null;
chunkSeq = 0;
```

- [ ] **Step 6: Handle `delete-backup-chunks`**

In the `chrome.runtime.onMessage` listener, add a new branch:

```js
if (message.target === "offscreen" && message.action === "delete-backup-chunks") {

    A3RecordingBackupDb
        .deleteChunksBySession(message.sessionId)
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error.message }));

    return true;
}
```

- [ ] **Step 7: Manual verification**

Reload the extension, start a recording from the popup, wait ~35s (past one 30s tick), open the offscreen DevTools console and run `await A3RecordingBackupDb.getChunksBySession(<sessionId from the console log or background state>)` — expect at least 1 row. Stop the recording normally and confirm the upload still completes exactly as before (check the popup's upload status and the dashboard).

- [ ] **Step 8: Commit**

```bash
git add extension/offscreen/offscreen.js
git commit -m "feat: back up recording chunks to IndexedDB every 30s"
git push
```

---

### Task 7: `background.js` — group-aware upload path

This is the linchpin task. It resolves the one design decision the spec left implicit: **a group is only ever created by the reconciliation path (Task 8), never by a normal "Parar"**. A deliberate stop either uploads a plain single-segment recording (no group — today's behavior, unchanged) or, if a group already exists for this `lessonKey` (meaning an earlier session for the same lesson was interrupted and reconciled), it closes that group as the final segment. `transcription_jobs` rows are only created for `is_final = true` uploads — a non-final segment is stored but not queued for transcription on its own; the merge (Task 10) creates the effective job content when the final segment lands.

**Files:**
- Modify: `A3-Recorder-split/extension/background.js`

**Interfaces:**
- Consumes: `A3LessonKey.lessonKey`, `A3RecordingGroups.getGroups`/`closeGroup`, `A3RecordingBackupDb` (not directly — only via the `delete-backup-chunks` message to the offscreen document, since the IndexedDB write happened there; background sends that message instead of touching the store itself, to keep a single writer/owner per session id at the point of upload for the deliberate-stop path — this mirrors how Task 8 will read/delete directly for the reconciliation path, since there the offscreen document is already gone).
- Produces: `currentRecording` (in `chrome.storage.session`) now also carries `lessonKey` and `sessionId`.
- Produces: a reusable `enviarParaSupabase({ title, moduleName, outputFolder, filename, audioBlob, recordingGroupId, segmentIndex, isFinal })` function — consumed by Task 8 (reconciliation) so both paths share one upload implementation.

- [ ] **Step 1: Compute and store `lessonKey`/`sessionId` in `iniciarGravacao`**

Replace the existing `salvarEstado({ currentRecording: {...} })` call inside `iniciarGravacao` (background.js, before the `streamId` lookup) with:

```js
const lessonKey = A3LessonKey.lessonKey(title, moduleName);
const sessionId = crypto.randomUUID();

await salvarEstado({

    currentRecording: {

        title:
            title ||
            "aula",

        outputFolder:
            outputFolder,

        moduleName:
            moduleName ||
            null,

        lessonKey:
            lessonKey,

        sessionId:
            sessionId
    }
});
```

- [ ] **Step 2: Pass `lessonKey`/`sessionId` to the offscreen document**

In the same function, update the `start-recording` message send to:

```js
const response =
    await chrome.runtime.sendMessage({

        target:
            "offscreen",

        action:
            "start-recording",

        streamId:
            streamId,

        title:
            currentRecording.title,

        lessonKey:
            currentRecording.lessonKey,

        sessionId:
            currentRecording.sessionId
    });
```

- [ ] **Step 3: Extract the upload logic into `enviarParaSupabase`**

Everything from `chrome.runtime.sendMessage({ action: "upload-status", stage: "uploading" })` through the `transcription_jobs` insert, inside today's `recording-finished` handler, becomes a standalone function. Insert it above the `chrome.runtime.onMessage.addListener(...)` block, replacing nothing yet (Step 4 rewires the caller):

```js
// ================================================================
// UPLOAD PARA O SUPABASE (compartilhado entre o fluxo normal de
// "Parar" e a reconciliação de sessões interrompidas)
// ================================================================

async function enviarParaSupabase({
    title,
    moduleName,
    filename,
    audioBlob,
    recordingGroupId,
    segmentIndex,
    isFinal
}) {

    const token = await A3Session.getValidAccessToken();
    const user = await A3Session.getCurrentUser();

    if (!token || !user) {
        throw new Error("Sessão expirada. Faça login novamente.");
    }

    const selection = await resolverCursoModulo(title, token, moduleName);

    const lessonRow = await A3Supabase.restInsert(
        "lessons",
        {
            module_id: selection.moduleId,
            lesson_number: selection.lessonNumber,
            title: selection.lessonTitle
        },
        token
    ).catch(async () => {
        const existing = await A3Supabase.restSelect(
            "lessons",
            `select=id&module_id=eq.${selection.moduleId}&lesson_number=eq.${selection.lessonNumber}`,
            token
        );
        return existing[0];
    });

    const nomeStorageSeguro = filename
        .normalize("NFD")
        .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
        .replace(/[^A-Za-z0-9._-]/g, "_");

    const storagePath = `${selection.courseId}/${selection.moduleId}/${lessonRow.id}/${nomeStorageSeguro}`;

    await A3Supabase.uploadToStorage("audio", storagePath, audioBlob, token);

    const audioFileRow = await A3Supabase.restInsert(
        "audio_files",
        {
            course_id: selection.courseId,
            module_id: selection.moduleId,
            lesson_id: lessonRow.id,
            uploaded_by: user.id,
            storage_path: storagePath,
            filename: filename,
            mime_type: "audio/webm",
            file_size: audioBlob.size,
            status: "uploaded",
            recording_group_id: recordingGroupId,
            segment_index: segmentIndex,
            is_final: isFinal
        },
        token
    );

    // Segmentos intermediários de um grupo (is_final: false) não geram
    // job de transcrição sozinhos — a junção (Task 10, supabase_worker.py)
    // só roda quando o segmento final sobe, e o job criado ali cobre o
    // grupo inteiro.
    if (isFinal) {
        await A3Supabase.restInsert(
            "transcription_jobs",
            {
                audio_file_id: audioFileRow.id,
                status: "pending"
            },
            token
        );
    }

    return audioFileRow;
}
```

- [ ] **Step 4: Rewire the `recording-finished` handler to use it, group-aware**

Replace the body of the `message.target === "background" && message.action === "recording-finished"` handler's `try` block (from the native-host save attempt onward — keep that part as-is) so the Supabase section reads:

```js
try {

    chrome.runtime.sendMessage({
        action: "upload-status",
        stage: "uploading"
    });

    const lessonKey = currentRecording.lessonKey || null;
    const groups = lessonKey ? await A3RecordingGroups.getGroups() : {};
    const existingGroup = lessonKey ? groups[lessonKey] : null;

    const audioByteArrays = message.chunks.map((chunk) => {
        const binary = atob(chunk);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    });

    const audioBlob = new Blob(audioByteArrays, { type: "audio/webm" });

    await enviarParaSupabase({
        title: currentRecording.title,
        moduleName: currentRecording.moduleName,
        filename: message.filename,
        audioBlob,
        recordingGroupId: existingGroup ? existingGroup.recordingGroupId : null,
        segmentIndex: existingGroup ? existingGroup.nextSegmentIndex : null,
        isFinal: true
    });

    if (existingGroup) {
        await A3RecordingGroups.closeGroup(lessonKey);
    }

    if (message.sessionId) {
        chrome.runtime.sendMessage({
            target: "offscreen",
            action: "delete-backup-chunks",
            sessionId: message.sessionId
        });
    }

    chrome.runtime.sendMessage({
        action: "upload-status",
        stage: "done"
    });

} catch (uploadError) {

    console.error("A3-OS: erro no upload para o Supabase:", uploadError);

    chrome.runtime.sendMessage({
        action: "upload-status",
        stage: "error",
        error: uploadError.message
    });
}
```

`resolverCursoModulo` stays exactly as-is and is now called from inside `enviarParaSupabase`.

- [ ] **Step 5: Regression check — single-session recording (no group)**

Record a short test lesson start-to-finish without any interruption. Confirm in Supabase (`execute_sql`):

```sql
SELECT recording_group_id, segment_index, is_final, status
FROM audio_files ORDER BY created_at DESC LIMIT 1;
```

Expected: `recording_group_id = null`, `segment_index = null`, `is_final = true`, `status = 'uploaded'` — identical to pre-change behavior. Confirm a `transcription_jobs` row was created for it.

- [ ] **Step 6: Commit**

```bash
git add extension/background.js
git commit -m "feat: group-aware upload path with shared enviarParaSupabase"
git push
```

---

### Task 8: Reconciliation on service-worker startup

**Files:**
- Modify: `A3-Recorder-split/extension/background.js`

**Interfaces:**
- Consumes: `A3RecordingBackupDb.getChunksBySession`/`deleteChunksBySession` (Task 4), `A3RecordingGroups.getGroups`/`createGroup`/`advanceSegment` (Task 5), `enviarParaSupabase` (Task 7).
- Produces: `reconciliarSessaoOrfa()`, invoked on `chrome.runtime.onStartup` and once at service-worker top-level (covers the case where Chrome killed the idle SW and later restarts it in response to any event, not just a full browser relaunch).

- [ ] **Step 1: Write the reconciliation function**

Add near `pararGravacao` in `background.js`:

```js
// ================================================================
// RECONCILIACAO DE SESSAO ORFA (Chrome fechou no meio de uma
// gravacao: o offscreen morreu sem passar por "Parar", mas os
// chunks da sessao continuam no IndexedDB)
// ================================================================

async function reconciliarSessaoOrfa() {

    try {

        const estado = await carregarEstado();

        if (!estado.recording) {
            return;
        }

        const gravandoDeVerdade = await consultarOffscreenGravando();

        if (gravandoDeVerdade) {
            // Sessao genuinamente em andamento (SW so' reiniciou) -
            // nada para reconciliar.
            return;
        }

        const sessionId = estado.currentRecording && estado.currentRecording.sessionId;
        const lessonKey = estado.currentRecording && estado.currentRecording.lessonKey;

        if (!sessionId || !lessonKey) {
            await salvarEstado({ recording: false });
            return;
        }

        const chunks = await A3RecordingBackupDb.getChunksBySession(sessionId);

        if (!chunks.length) {
            // Nada foi salvo a tempo (interrupcao antes do primeiro
            // tick de 30s) - nao ha' o que recuperar.
            await salvarEstado({ recording: false });
            return;
        }

        console.log(`A3-OS Recorder: recuperando sessão interrompida (${chunks.length} pedaço(s)).`);

        const groups = await A3RecordingGroups.getGroups();
        let group = groups[lessonKey];

        if (!group) {
            group = await A3RecordingGroups.createGroup(lessonKey, estado.currentRecording);
        }

        const segmentIndex = group.nextSegmentIndex;

        const audioBlob = new Blob(chunks.map((c) => c.blob), { type: "audio/webm" });

        const filenameBase = (estado.currentRecording.title || "aula")
            .replace(/[<>:"/\\|?*#%]/g, "")
            .replace(/\s+/g, " ")
            .trim() || "aula";

        const filename = `${filenameBase}_${Date.now()}.webm`;

        await enviarParaSupabase({
            title: estado.currentRecording.title,
            moduleName: estado.currentRecording.moduleName,
            filename,
            audioBlob,
            recordingGroupId: group.recordingGroupId,
            segmentIndex,
            isFinal: false
        });

        await A3RecordingGroups.advanceSegment(lessonKey);
        await A3RecordingBackupDb.deleteChunksBySession(sessionId);

        console.log("A3-OS Recorder: segmento recuperado e enviado com sucesso.");

    } catch (error) {

        // Falha aqui (sem internet, sessao expirada) nao apaga nada -
        // os chunks continuam no IndexedDB e a proxima reconciliacao
        // (proximo boot) tenta de novo.
        console.error("A3-OS Recorder: falha na reconciliação de sessão órfã:", error);

    } finally {

        await salvarEstado({ recording: false });
        chrome.action.setIcon({ path: ICON_NORMAL });
    }
}

chrome.runtime.onStartup.addListener(reconciliarSessaoOrfa);
reconciliarSessaoOrfa();
```

Place this call (`reconciliarSessaoOrfa();`) alongside the existing top-level `enviarHeartbeat();` call, so it also runs whenever Chrome wakes the service worker up for any reason after it was killed.

- [ ] **Step 2: Manual verification — simulated interruption**

1. Start a recording from the popup on a real lesson page.
2. Wait ~40s (at least one 30s tick has fired).
3. Open `chrome://extensions`, click the extension's service worker link to open its DevTools, and terminate it (`chrome://serviceworker-internals` → "Stop", or close the DevTools panel and use `chrome.runtime.reload()` from the console of a different context — simplest: just close the entire Chrome window without stopping the recording first, then reopen Chrome).
4. Reopen Chrome / the extension. Within a few seconds, check the Supabase `audio_files` table:

```sql
SELECT recording_group_id, segment_index, is_final, status, duration
FROM audio_files ORDER BY created_at DESC LIMIT 1;
```

Expected: a new row with `recording_group_id` set (not null), `segment_index = 0`, `is_final = false`, `status = 'uploaded'`. Confirm **no** `transcription_jobs` row was created for this row (`SELECT * FROM transcription_jobs WHERE audio_file_id = '<id>'` → empty).

5. Click "Gravar" again in the popup on the **same** lesson page/title. Confirm (via the background service worker console) that `(await A3RecordingGroups.getGroups())` still shows the group with `nextSegmentIndex = 1`.
6. Click "Parar" normally. Confirm the new segment lands with `segment_index = 1`, `is_final = true`, and the group is gone from `A3RecordingGroups.getGroups()`.

- [ ] **Step 3: Commit**

```bash
git add extension/background.js
git commit -m "feat: reconcile orphaned recording sessions on service-worker startup"
git push
```

---

### Task 9: 7-day expiry sweep

**Files:**
- Modify: `A3-Recorder-split/extension/background.js`

**Interfaces:**
- Consumes: `A3RecordingGroups.listExpiredGroups`/`closeGroup`, `A3Supabase.restSelect`/`restUpdate`, `A3Supabase.restInsert` (for the newly-created `transcription_jobs` row, since expiring a group makes its last segment final).

- [ ] **Step 1: Add the alarm and its handler**

Near the existing `HEARTBEAT_ALARM` setup in `background.js`:

```js
const GROUP_EXPIRY_ALARM = "a3os-group-expiry-sweep";
const GROUP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

chrome.alarms.create(GROUP_EXPIRY_ALARM, {
    periodInMinutes: 24 * 60 // uma vez por dia
});

chrome.alarms.onAlarm.addListener((alarm) => {

    if (alarm.name === HEARTBEAT_ALARM) {
        enviarHeartbeat();
    }

    if (alarm.name === GROUP_EXPIRY_ALARM) {
        varrerGruposExpirados();
    }
});

async function varrerGruposExpirados() {

    try {

        const expirados = await A3RecordingGroups.listExpiredGroups(GROUP_EXPIRY_MS);

        for (const grupo of expirados) {

            try {

                const token = await A3Session.getValidAccessToken();

                if (!token) {
                    continue;
                }

                const segmentos = await A3Supabase.restSelect(
                    "audio_files",
                    `select=id&recording_group_id=eq.${grupo.recordingGroupId}&order=segment_index.desc&limit=1`,
                    token
                );

                const ultimoSegmento = segmentos[0];

                if (ultimoSegmento) {

                    await A3Supabase.restUpdate(
                        "audio_files",
                        `id=eq.${ultimoSegmento.id}`,
                        { is_final: true },
                        token
                    );

                    await A3Supabase.restInsert(
                        "transcription_jobs",
                        {
                            audio_file_id: ultimoSegmento.id,
                            status: "pending"
                        },
                        token
                    );

                    console.log(`A3-OS Recorder: grupo expirado (${grupo.lessonKey}) fechado automaticamente após 7 dias.`);
                }

                await A3RecordingGroups.closeGroup(grupo.lessonKey);

            } catch (error) {

                console.error(`A3-OS Recorder: falha ao expirar grupo ${grupo.lessonKey}:`, error);
                // Nao fecha o grupo localmente se a atualizacao no Supabase
                // falhou - tenta de novo na proxima varredura diaria.
            }
        }

    } catch (error) {

        console.error("A3-OS Recorder: falha na varredura de grupos expirados:", error);
    }
}
```

- [ ] **Step 2: Verify `A3Supabase.restUpdate` exists with this signature**

Read `extension/lib/supabase.js` and confirm `restUpdate(table, filter, fields, token)` matches the call above (it's already used by `enviarHeartbeat` in this same file — `A3Supabase.restUpdate("profiles", ...)` — so the signature is established; just confirm the filter-string form `"id=eq.<id>"` matches).

- [ ] **Step 3: Manual verification**

In the background service worker's DevTools console, simulate an expired group without waiting 7 real days:

```js
const groups = await A3RecordingGroups.getGroups();
groups["teste-expirado"] = {
    recordingGroupId: crypto.randomUUID(),
    nextSegmentIndex: 1,
    lastActivityAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    title: "Aula Teste Expirada", outputFolder: "", moduleName: null
};
await chrome.storage.local.set({ recordingGroups: groups });
```

(This group has no real `audio_files` rows, so the sweep will just find no segment and close it — for a fuller test, first run Task 8's Step 2 flow to get a real `recording_group_id` with one uploaded segment, then edit that group's `lastActivityAt` in storage to be 8 days old.) Trigger the sweep manually: `chrome.alarms.onAlarm.dispatch ` isn't available from the console, so instead call `varrerGruposExpirados()` directly. Confirm the group disappears from `A3RecordingGroups.getGroups()` and, for the real-segment case, that the segment's `is_final` became `true` and a `transcription_jobs` row was created.

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "feat: expire abandoned recording groups after 7 days"
git push
```

---

### Task 10: Worker — merge grouped segments before transcribing

**Files:**
- Modify: `Transcritor Local/supabase_worker.py`

**Interfaces:**
- Consumes: `recording_group_id`, `is_final` now present on the dict returned by `reserve_transcription_job` (Task 1) — read via `job.get("recording_group_id")` / `job.get("is_final")`.
- Produces: `baixar_segmentos_grupo(recording_group_id)`, `juntar_segmentos(caminhos, destino)` — used only inside `process_job`.

- [ ] **Step 1: Add the segment download + concat helpers**

Add above `process_job` in `supabase_worker.py`:

```python
def baixar_segmentos_grupo(recording_group_id):
    # Segmentos de um mesmo grupo sao arquivos .webm de instancias
    # separadas do MediaRecorder — cada um com seu proprio cabecalho de
    # conteiner, entao nao da pra concatenar bytes direto; baixamos
    # todos e deixamos o ffmpeg (concat demuxer) costurar.
    segmentos = get("audio_files", {
        "recording_group_id": f"eq.{recording_group_id}",
        "select": "id,storage_path,filename,segment_index",
        "order": "segment_index.asc"
    })

    caminhos = []
    for segmento in segmentos:
        destino = TMP_AUDIO_DIR / f"segment_{segmento['segment_index']}_{segmento['filename']}"
        download_audio(segmento["storage_path"], destino)
        caminhos.append({"audio_file_id": segmento["id"], "path": destino})

    return caminhos


def juntar_segmentos(caminhos, destino):
    lista_path = TMP_AUDIO_DIR / f"concat_{destino.stem}.txt"

    linhas = "\n".join(f"file '{item['path'].as_posix()}'" for item in caminhos)
    lista_path.write_text(linhas, encoding="utf-8")

    try:
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lista_path), "-c", "copy", str(destino)],
            check=True, capture_output=True, text=True, timeout=120
        )
    finally:
        lista_path.unlink(missing_ok=True)
```

- [ ] **Step 2: Wire it into `process_job`**

In `process_job`, right after `download_audio(storage_path, local_audio_path)` (around `supabase_worker.py:434`), add the group-merge branch:

```python
        download_audio(storage_path, local_audio_path)

        recording_group_id = job.get("recording_group_id")
        is_final = job.get("is_final", True)
        segmentos_grupo = []

        if recording_group_id and is_final:
            print(f"[JOB {job_id}] segmento final de grupo {recording_group_id} — juntando segmentos.")
            segmentos_grupo = baixar_segmentos_grupo(recording_group_id)

            if len(segmentos_grupo) > 1:
                juntar_segmentos(segmentos_grupo, local_audio_path)
            # Um so' segmento no grupo (ex.: reconciliacao nunca disparou
            # de novo) — nada a juntar, local_audio_path ja' e' o correto.
```

Then, in the success path — right after `patch("lessons", lesson_id, {"status": "completed"})` (around `supabase_worker.py:480`) — mark the non-final segments as merged and clean up their temp files:

```python
        patch("lessons", lesson_id, {"status": "completed"})

        for item in segmentos_grupo:
            if item["audio_file_id"] != audio_file_id:
                patch("audio_files", item["audio_file_id"], {"status": "merged"})
```

And in the existing `finally` block (around `supabase_worker.py:527`), extend the cleanup to the downloaded segment files:

```python
    finally:

        if local_audio_path.exists():
            local_audio_path.unlink()

        for item in segmentos_grupo:
            if item["path"].exists() and item["path"] != local_audio_path:
                item["path"].unlink()
```

`segmentos_grupo` must be initialized to `[]` before the `try` block (alongside `local_audio_path`) so the `finally` clause can reference it even if the group branch never ran or raised before completing:

```python
    TMP_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    local_audio_path = TMP_AUDIO_DIR / filename
    segmentos_grupo = []

    try:
```

- [ ] **Step 3: Verify `duracao`/`duration-check` still runs on the merged file**

Confirm `detectar_duracao(local_audio_path)` (called right after the download/merge block) now measures the **merged** file's duration when a group was involved — this is already correct by construction since `juntar_segmentos` overwrites `local_audio_path`, and `detectar_duracao` is called after the merge branch, not before. No code change needed here — just confirm the call order by reading the surrounding lines after Step 2's edit.

- [ ] **Step 4: Manual verification**

Using the two real segments produced by Task 8's Step 2 walkthrough (one `is_final: false`, one `is_final: true`, same `recording_group_id`), let the worker pick up the job for the final segment (`python supabase_worker.py`, or however it's normally launched) and confirm in its console output that "juntando segmentos" is logged, the resulting transcription's duration roughly matches the sum of both segments' real recording time, and afterward:

```sql
SELECT id, segment_index, is_final, status FROM audio_files
WHERE recording_group_id = '<the group id>' ORDER BY segment_index;
```

Expected: the non-final row now has `status = 'merged'`, the final row has `status = 'completed'`.

- [ ] **Step 5: Commit**

```bash
git add supabase_worker.py
git commit -m "feat: merge grouped recording segments with ffmpeg before transcribing"
git push
```

---

### Task 11: End-to-end regression pass

**Files:** none (verification only).

- [ ] **Step 1: Common case, unchanged**

Record a normal lesson start-to-finish with no interruption. Confirm: single `audio_files` row, `recording_group_id = null`, transcription completes, dashboard shows it as a normal completed lesson (no "pausada"/"incompleta" warning unless duration genuinely warrants it — unrelated to this feature).

- [ ] **Step 2: Full interruption-and-resume cycle**

Repeat Task 8 Step 2 end-to-end, but this time let the worker actually process the final segment's job (don't stop after inspecting the DB). Confirm: the dashboard's "Resumos pendentes" tab does **not** show this lesson as incomplete/paused once transcription completes (the merged duration should be close to the expected duration for a lesson recorded in two honest sittings) — spot-check the transcript's content spans both recorded segments' audio without a gap or repeat.

- [ ] **Step 3: IndexedDB cleanup confirmed**

After Step 2 completes, in the background service worker's console: `await A3RecordingBackupDb.getChunksBySession(<the sessionId from either segment>)` — expect `[]` for both segments' session ids (Task 7 Step 4 deletes it on the deliberate-stop path; Task 8 Step 1 deletes it on the reconciliation path).

- [ ] **Step 4: Update the design spec's status**

In `A3-Recorder-split/docs/superpowers/specs/2026-09-07-gravacao-resiliente-design.md`, no change needed — the spec describes the design, not an implementation log. If the plan's Task 7 ruling (group creation only via reconciliation) should be reflected back into the spec for future readers, add one sentence to the spec's "Camada 2" section clarifying it, and republish the HTML artifact (see the earlier published page) with the same addition.

- [ ] **Step 5: Final commit / wrap-up**

No code changes in this task — if Step 4's spec clarification was made, commit it:

```bash
cd "A3-Recorder-split"
git add docs/superpowers/specs/2026-09-07-gravacao-resiliente-design.md
git commit -m "docs: clarify that recording groups are created only via reconciliation"
git push
```
