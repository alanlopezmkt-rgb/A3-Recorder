// extension/test/recording-groups.test.js
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

// Mock mínimo de chrome.storage.local em memória.
let storage = {};
global.chrome = {
    storage: {
        local: {
            get: async (key) => ({ [key]: storage[key] }),
            set: async (obj) => { storage = { ...storage, ...obj }; }
        }
    }
};
global.crypto = { randomUUID: () => 'test-uuid' };
global.self = global;

require('../lib/recording-groups.js');
const { createGroup, addSegmentPath, bumpSegmentIndex, closeGroup } = self.A3RecordingGroups;

beforeEach(() => { storage = {}; });

test('createGroup inicializa totalRecordedSeconds com o primeiro segmento', async () => {
    const group = await createGroup('aula-1', { title: 'Aula 1', segmentDurationSeconds: 90 });
    assert.strictEqual(group.totalRecordedSeconds, 90);
});

test('createGroup guarda o primeiro caminho de trecho quando informado', async () => {
    const group = await createGroup('aula-1', {
        title: 'Aula 1',
        segmentDurationSeconds: 90,
        segmentPath: 'curso/mod/aula/trecho-1.webm'
    });
    assert.deepStrictEqual(group.segmentPaths, ['curso/mod/aula/trecho-1.webm']);
});

test('addSegmentPath acumula duração, índice e caminhos em múltiplas chamadas', async () => {
    await createGroup('aula-1', {
        title: 'Aula 1',
        segmentDurationSeconds: 90,
        segmentPath: 'p/trecho-1.webm'
    });
    await addSegmentPath('aula-1', 'p/trecho-2.webm', 60);
    await addSegmentPath('aula-1', 'p/trecho-3.webm', 30);

    const groups = await self.A3RecordingGroups.getGroups();
    assert.strictEqual(groups['aula-1'].totalRecordedSeconds, 180);
    assert.strictEqual(groups['aula-1'].nextSegmentIndex, 2);
    assert.deepStrictEqual(groups['aula-1'].segmentPaths, [
        'p/trecho-1.webm',
        'p/trecho-2.webm',
        'p/trecho-3.webm'
    ]);
});

// Cobertura da Task 6: caminho tomado por background.js quando o usuário
// confirma "Parar mesmo assim" (isFinal === false) num "recording-finished".
// O handler em si não é testável isoladamente (depende de chrome.runtime/
// chrome.storage.session e de todo o módulo background.js, que não expõe
// suas funções internas para require()); o que é testável é o comportamento
// de A3RecordingGroups que esse caminho invoca — criar o grupo na primeira
// parada incompleta, e avançar o segmento nas seguintes.
test('primeira parada incompleta de uma aula cria o grupo (sem existingGroup)', async () => {
    const group = await createGroup('aula-2', {
        title: 'Aula 2',
        outputFolder: 'C:/gravacoes',
        moduleName: 'Modulo 1',
        segmentDurationSeconds: 42,
        segmentPath: 'p/trecho-1.webm'
    });

    assert.strictEqual(group.nextSegmentIndex, 0);
    assert.strictEqual(group.totalRecordedSeconds, 42);
    assert.deepStrictEqual(group.segmentPaths, ['p/trecho-1.webm']);

    const groups = await self.A3RecordingGroups.getGroups();
    assert.ok(groups['aula-2'], 'grupo deve permanecer aberto (sem closeGroup)');
});

test('bumpSegmentIndex só avança o índice, sem mexer na duração', async () => {
    await createGroup('aula-2b', { title: 'Aula', segmentDurationSeconds: 42, segmentPath: 'p/1.webm' });
    await bumpSegmentIndex('aula-2b');

    const groups = await self.A3RecordingGroups.getGroups();
    assert.strictEqual(groups['aula-2b'].nextSegmentIndex, 1);
    assert.strictEqual(groups['aula-2b'].totalRecordedSeconds, 42);
});

test('segunda parada incompleta da mesma aula avança o segmento existente', async () => {
    await createGroup('aula-3', { title: 'Aula 3', segmentDurationSeconds: 100, segmentPath: 'p/1.webm' });
    await addSegmentPath('aula-3', 'p/2.webm', 55);

    const groups = await self.A3RecordingGroups.getGroups();
    assert.strictEqual(groups['aula-3'].nextSegmentIndex, 1);
    assert.strictEqual(groups['aula-3'].totalRecordedSeconds, 155);
});

test('closeGroup remove o grupo (caminho isFinal === true)', async () => {
    await createGroup('aula-4', { title: 'Aula 4', segmentDurationSeconds: 10 });
    await closeGroup('aula-4');

    const groups = await self.A3RecordingGroups.getGroups();
    assert.strictEqual(groups['aula-4'], undefined);
});
