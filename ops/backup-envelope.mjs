// Перенос пароля копий: отдельный шифрованный конверт с паролем, выбранным владельцем.
// AES-256-GCM проверяет целостность; PBKDF2-SHA256 позволяет открыть файл Web Crypto.
// Значение не выводится; командный режим принимает настройки только через stdin.
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const iterations = 600000;
export function seal(value, password) {
  if (password.length < 16) throw Error('Use at least 16 characters.');
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    return { version: 1, algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations, salt: salt.toString('base64'), iv: iv.toString('base64'), data: data.toString('base64') };
  } finally { key.fill(0); }
}
export function unseal(envelope, password) {
  if (envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM' || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== iterations) throw Error('Unsupported envelope.');
  const data = Buffer.from(envelope.data, 'base64');
  if (data.length < 16) throw Error('Invalid envelope.');
  const key = pbkdf2Sync(password, Buffer.from(envelope.salt, 'base64'), iterations, 32, 'sha256');
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]);
  } finally { key.fill(0); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const raw = readFileSync(input.source);
    try {
      const envelope = seal(raw, input.password);
      const check = unseal(envelope, input.password);
      if (!raw.equals(check)) throw Error('Verification failed.');
      check.fill(0);
      writeFileSync(input.output, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
      console.log('Encrypted file created and verified. No password displayed.');
    } finally { raw.fill(0); input.password = ''; }
  } catch { console.error('Encrypted file not created. Check paths and use a new output filename.'); process.exitCode = 1; }
}
