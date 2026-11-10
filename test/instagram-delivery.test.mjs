import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';
const dir=mkdtempSync(path.join(tmpdir(),'ig-delivery-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');process.env.PUBLIC_BASE_URL='https://origin.example';process.env.IG_RELAY_URL='https://relay.example';
const lib=await import('../src/media/library.mjs'),store=await import('../src/queue/store.mjs'),{publicationMedia}=await import('../src/media/for-publish.mjs');
test('Instagram получает approval-bound relay URL даже для verified S3 и прежней delivery; отзыв закрывает выдачу',async()=>{
 const file=path.join(dir,'synthetic.jpg');writeFileSync(file,Buffer.from([255,216,255,224,1,2,3]));
 const original=await lib.importMedia(file,{material:'case',source:'synthetic'}),pub=await lib.importMedia(file,{material:'case',source:'synthetic',role:'publication',parent:original.mediaId});
 const indexFile=path.join(dir,'media-library','index.json'),index=JSON.parse(readFileSync(indexFile));const row=index.items.find(r=>r.mediaId===pub.mediaId);row.replica={status:'verified'};row.delivery={kind:'explicit-public',url:'https://old.example/photo.jpg'};writeFileSync(indexFile,JSON.stringify(index));
 const e=(await store.put({channel:'instagram',kind:'carousel',name:'ig-delivery',material:'case',text:'Синтетическая подпись.',facts:[],media:[{type:'image',mediaId:pub.mediaId},{type:'image',mediaId:pub.mediaId}],date:'2030-01-01',time:'12:00'})).entry;
 await store.transition(e.id,'review');await store.transition(e.id,'approved',{approval:{at:'2030-01-01T00:00:00Z',cardHash:e.contentHash}});
 const current=store.get(e.id),ready=await publicationMedia(current);assert.equal(ready.media.length,2);assert.deepEqual(ready.media.map(m=>m.mediaId),current.media.map(m=>m.mediaId));for(const m of ready.media)assert.equal(m.url,`https://relay.example/media/approved/${e.id}/${e.contentHash}/${pub.mediaId}.jpg`);
 assert.equal(lib.rows().find(r=>r.mediaId===pub.mediaId).replica.status,'verified');
 await store.transition(e.id,'review');await assert.rejects(publicationMedia(current),/approval required/);
});
