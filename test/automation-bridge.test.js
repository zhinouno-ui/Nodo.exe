const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutomationBridge } = require('../automation-bridge');

test('expose both boAutomation and drexAutomation aliases with the same allowlist', async () => {
  const calls = [];
  const ipcRenderer = {
    invoke: async (channel, payload) => {
      calls.push([channel, payload]);
      return { ok: true, channel, payload };
    }
  };

  const bridge = createAutomationBridge(ipcRenderer);

  assert.equal(typeof bridge.boAutomation, 'function');
  assert.equal(typeof bridge.drexAutomation, 'function');
  assert.equal(typeof bridge.automation, 'function');

  const result = await bridge.drexAutomation('buscarUsuario', 'pepito');

  assert.deepEqual(calls[0], ['drex:automation', { method: 'buscarUsuario', args: ['pepito'] }]);
  assert.deepEqual(result, { ok: true, channel: 'drex:automation', payload: { method: 'buscarUsuario', args: ['pepito'] } });
});

test('rejects disallowed methods for every automation alias', async () => {
  const bridge = createAutomationBridge({ invoke: async () => ({ ok: true }) });

  await assert.rejects(() => bridge.boAutomation('evalCode', 'x'), /Método no permitido/);
  await assert.rejects(() => bridge.drexAutomation('evalCode', 'x'), /Método no permitido/);
  await assert.rejects(() => bridge.automation('evalCode', 'x'), /Método no permitido/);
});
