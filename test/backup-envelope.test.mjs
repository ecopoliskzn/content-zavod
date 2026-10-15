import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal } from '../ops/backup-envelope.mjs';
test('конверт пароля открывается на другой машине и отвергает неправильный пароль', () => {
  const original = Buffer.from('test-backup-password');
  const envelope = seal(original, 'test-transfer-password-long');
  assert.equal(JSON.stringify(envelope).includes(original.toString()), false);
  assert.deepEqual(unseal(envelope, 'test-transfer-password-long'), original);
  assert.throws(() => unseal(envelope, 'wrong-password'));
  const changed = structuredClone(envelope);
  changed.data = Buffer.alloc(12).toString('base64');
  assert.throws(() => unseal(changed, 'test-transfer-password-long'));
});
