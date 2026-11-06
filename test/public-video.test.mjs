import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'public-video-'));
process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');
const {publicMedia}=await import('../src/media/public.mjs');
const root=path.join(process.env.DATA_DIR,'public-media');mkdirSync(root);
const name='c'.repeat(64)+'.mp4',url=`/media/${name}`;
const bytes=Buffer.from('synthetic-publication-video');writeFileSync(path.join(root,name),bytes);
async function body(r){if(!r.stream)return r.body;const chunks=[];for await(const c of r.stream)chunks.push(c);return Buffer.concat(chunks);}
test('публикационный MP4 передаётся потоком, HEAD не читает тело',async()=>{
 const r=publicMedia(url,'GET');assert.equal(r.status,200);assert.equal(r.headers['content-type'],'video/mp4');assert.equal(r.headers['accept-ranges'],'bytes');assert.deepEqual(await body(r),bytes);
 const h=publicMedia(url,'HEAD');assert.equal(h.status,200);assert.equal(h.stream,undefined);assert.equal(h.body.length,0);assert.equal(h.headers['content-length'],String(bytes.length));
});
test('Meta может скачать точный диапазон или хвост MP4; неверный диапазон не отдаёт весь файл',async()=>{
 for(const [range,expected] of [['bytes=2-5',bytes.subarray(2,6)],['bytes=-4',bytes.subarray(-4)],['bytes=4-',bytes.subarray(4)]]){
  const r=publicMedia(url,'GET',{range});assert.equal(r.status,206);assert.deepEqual(await body(r),expected);assert.equal(Number(r.headers['content-length']),expected.length);
 }
 for(const range of ['bytes=999-','bytes=5-2','bytes=0-1,4-5','bytes=-0','items=1-2']){const r=publicMedia(url,'GET',{range});assert.equal(r.status,416);assert.equal(r.headers['content-range'],`bytes */${bytes.length}`);assert.equal(r.stream,undefined);}
});
test('видео не открывает каталог, оригиналы или произвольные пути',()=>{
 for(const p of ['/media/','/media/../media-library/blobs/x',`/media/${'d'.repeat(64)}.mp4`,`/media/${name}/extra`])assert.equal(publicMedia(p,'GET').status,404);
 assert.equal(publicMedia(url,'POST').status,404);
});
