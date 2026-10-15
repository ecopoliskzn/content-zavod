import test from 'node:test';
import assert from 'node:assert/strict';
import { putObject } from '../src/lib/s3.mjs';

test('отказ S3 с пустым Message не отправляет XML в HTML-тревогу', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message></Message><RequestId>internal</RequestId></Error>', { status: 403 });
  try {
    const result = await putObject({ endpoint: 'https://storage.invalid', bucket: 'backup', key: 'test.enc', body: Buffer.from('test'), contentType: 'application/octet-stream', accessKey: 'test', secretKey: 'test', region: 'ru-1' });
    assert.equal(result.error, 'S3 SignatureDoesNotMatch (HTTP 403)');
  } finally { globalThis.fetch = original; }
});
