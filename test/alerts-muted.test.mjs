import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(os.tmpdir(), 'zavod-muted-'));
process.env.ZAVOD_ENV_FILE = path.join(dir, 'absent.env');
process.env.DATA_DIR = dir;
process.env.ALERTS_MUTED = '1';
const { alert } = await import('../src/lib/notify.mjs');
test('приглушение тревог не отправляет сообщения и не записывает дедупликацию', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Network must not be called'); };
  try {
    assert.deepEqual(await alert('backup:test', 'test', { action: 'test' }), { ok: true, skipped: true, muted: true });
    assert.equal(existsSync(path.join(dir, 'alerts.json')), false);
  } finally { globalThis.fetch = original; }
});
