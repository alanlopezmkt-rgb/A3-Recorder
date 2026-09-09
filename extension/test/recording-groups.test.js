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
const { createGroup, advanceSegment } = self.A3RecordingGroups;

beforeEach(() => { storage = {}; });

test('createGroup inicializa totalRecordedSeconds com o primeiro segmento', async () => {
    const group = await createGroup('aula-1', { title: 'Aula 1', segmentDurationSeconds: 90 });
    assert.strictEqual(group.totalRecordedSeconds, 90);
});

test('advanceSegment acumula duração em múltiplas chamadas', async () => {
    await createGroup('aula-1', { title: 'Aula 1', segmentDurationSeconds: 90 });
    await advanceSegment('aula-1', 60);
    await advanceSegment('aula-1', 30);

    const groups = await self.A3RecordingGroups.getGroups();
    assert.strictEqual(groups['aula-1'].totalRecordedSeconds, 180);
    assert.strictEqual(groups['aula-1'].nextSegmentIndex, 2);
});
