// extension/lib/recording-groups.js
//
// Metadado leve (chrome.storage.local) de aulas com gravação "em
// aberto" — ou porque uma interrupção foi detectada e ainda não foi
// fechada com um "Parar" de propósito. Ver docs/superpowers/specs/
// 2026-09-07-gravacao-resiliente-design.md.
//
// Os trechos de uma gravação incompleta ("Parar mesmo assim") NÃO
// viram linha em audio_files: sobem só pro Storage e o caminho fica
// aqui, em group.segmentPaths. A lista inteira entra em
// segment_storage_paths na linha final (is_final) quando a aula é
// concluída — só aí a aula "aparece no banco". Ver background.js e
// Transcritor Local/supabase_worker.py.

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
        moduleName: meta.moduleName || null,
        totalRecordedSeconds: meta.segmentDurationSeconds || 0,
        // Caminhos no Storage dos trechos já enviados desta aula.
        segmentPaths: meta.segmentPath ? [meta.segmentPath] : []
    };
    groups[lessonKey] = group;
    await saveGroups(groups);
    return group;
}

// Registra mais um trecho enviado (só pro Storage) de uma gravação
// incompleta: guarda o caminho, avança o índice do próximo segmento e
// soma a duração ao total do grupo.
async function addSegmentPath(lessonKey, storagePath, segmentDurationSeconds) {
    const groups = await getGroups();
    const group = groups[lessonKey];
    if (!group) {
        return null;
    }
    group.segmentPaths = group.segmentPaths || [];
    if (storagePath) {
        group.segmentPaths.push(storagePath);
    }
    group.nextSegmentIndex += 1;
    group.totalRecordedSeconds =
        (group.totalRecordedSeconds || 0) + (segmentDurationSeconds || 0);
    group.lastActivityAt = new Date().toISOString();
    await saveGroups(groups);
    return group;
}

// Só avança o índice do próximo segmento, sem mexer na duração nem nos
// caminhos — usado logo após createGroup, cujo primeiro segmento já foi
// contabilizado na criação.
async function bumpSegmentIndex(lessonKey) {
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
    addSegmentPath,
    bumpSegmentIndex,
    closeGroup,
    listExpiredGroups
};
