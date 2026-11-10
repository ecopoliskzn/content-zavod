import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'approved-media-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');process.env.PUBLIC_BASE_URL='https://ecopolisgo.ru';
const lib=await import('../src/media/library.mjs'),store=await import('../src/queue/store.mjs'),{approvedMedia}=await import('../src/media/approved.mjs');
test('новая publication без S3: до согласия закрыта, после — проверенный media URL, отзыв закрывает',async()=>{
 const file=path.join(dir,'photo.jpg');writeFileSync(file,Buffer.from([255,216,255,224,0,1,2,3]));const original=await lib.importMedia(file,{material:'case',source:'synthetic',role:'original'}),pub=await lib.importMedia(file,{material:'case',source:'synthetic',role:'publication',parent:original.mediaId});
 const raw={channel:'telegram',kind:'post',name:'native-approved',material:'case',text:'Образец покрытия.',facts:[],media:[{type:'image',mediaId:pub.mediaId}],date:'2030-01-01',time:'12:00'};const e=(await store.put(raw)).entry;
 await assert.rejects(()=>lib.resolveEntryMedia(e),/согласован/);await store.transition(e.id,'review');await store.transition(e.id,'approved',{approval:{at:'2030-01-01T00:00:00Z',cardHash:e.contentHash}});
 const ready=await lib.resolveEntryMedia(store.get(e.id));const url=new URL(ready.media[0].url).pathname;assert.match(url,/\/media\/approved\//);assert.equal(approvedMedia(url,'HEAD').status,200);
 assert.equal(approvedMedia(url.replace(pub.mediaId,original.mediaId),'HEAD').status,404);
 await store.transition(e.id,'review');assert.equal(approvedMedia(url,'HEAD').status,404);
});
