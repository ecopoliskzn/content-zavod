import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'public-media-'));
process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');
const {publicMedia}=await import('../src/media/public.mjs');
test('публичная выдача: только отдельный каталог и точные имена по хешу, без backup/списка файлов',()=>{
  const root=path.join(process.env.DATA_DIR,'public-media');mkdirSync(root);
  const name='a'.repeat(64)+'.jpg';writeFileSync(path.join(root,name),'synthetic bytes');
  const r=publicMedia(`/media/${name}`,'GET');assert.equal(r.status,200);assert.equal(r.body.toString(),'synthetic bytes');assert.equal(r.headers['content-type'],'image/jpeg');
  assert.equal(publicMedia(`/media/${name}`,'HEAD').body.length,0);
  for(const url of ['/media/','/media/../.env','/media/%2e%2e/.env','/media/backup.tar.gz',`/media/${'b'.repeat(64)}.jpg`])assert.equal(publicMedia(url,'GET').status,404);
  assert.equal(publicMedia('/health','GET'),null);
});
