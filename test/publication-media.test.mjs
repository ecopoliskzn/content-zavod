import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'publication-media-'));process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');
const {publicationMedia}=await import('../src/media/for-publish.mjs');
const youtube=await import('../src/channels/youtube.mjs');
test('уже загруженный согласованный YouTube не запрашивает адрес повторной доставки файла',async()=>{
 const e={channel:'youtube',contentHash:'same',extra:{youtubeId:'synthetic',youtubeHash:'same'},media:[{mediaId:'registered-publication'}]};let calls=0;
 assert.equal(await publicationMedia(e,{resolve:async()=>{calls++;throw Error('S3 unavailable');}}),e);assert.equal(calls,0);
});
test('неактуальный или отсутствующий YouTube upload не открывается',async()=>{
 const stale=await youtube.publish(await publicationMedia({channel:'youtube',contentHash:'new',extra:{youtubeId:'synthetic',youtubeHash:'old'}}));
 assert.equal(stale.ok,false);assert.match(stale.error,/прежние название и описание/);
 const missing=await youtube.publish(await publicationMedia({channel:'youtube',contentHash:'same'}));
 assert.equal(missing.ok,false);assert.match(missing.error,/не загружен/);
});
test('для Instagram сохраняется штатная доставка и её отказ не обходится',async()=>{
 let calls=0;const e={channel:'instagram'};
 await assert.rejects(()=>publicationMedia(e,{resolve:async()=>{calls++;throw Error('S3 unavailable');}}),/S3 unavailable/);assert.equal(calls,1);
});
