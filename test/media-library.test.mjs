import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'library-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');
const lib=await import('../src/media/library.mjs');
test('импорт закрыт, дедупликация и версии не затирают оригиналы',async()=>{
 const file=path.join(dir,'one.jpg');writeFileSync(file,'first');
 const a=await lib.importMedia(file,{material:'case:test',source:'operator',role:'original'});
 const same=await lib.importMedia(file,{material:'case:test',source:'operator',role:'original'});
 assert.equal(a.mediaId,same.mediaId);assert.equal(a.delivery,null);assert.equal(a.version,1);
 writeFileSync(file,'second');const b=await lib.importMedia(file,{material:'case:test',source:'operator',role:'original'});
 assert.notEqual(a.mediaId,b.mediaId);assert.equal(b.version,2);assert.equal(b.supersedes,a.mediaId);
 assert.equal(readFileSync(lib.blobPath(a),'utf8'),'first');
 const pub=await lib.importMedia(file,{material:'case:test',source:'operator',role:'publication',parent:b.mediaId,variant:'telegram'});
 assert.equal(pub.parent,b.mediaId);assert.equal(pub.delivery,null);
 await assert.rejects(()=>lib.resolveEntryMedia({status:'draft',material:'case:test',media:[{type:'image',mediaId:pub.mediaId}]}),/согласован/);
});
test('оригинал, чужой material и неизвестный mediaId не выдаются площадке',async()=>{
 const row=lib.rows().find(r=>r.role==='original');
 for(const id of [row.mediaId,'med_'+'f'.repeat(32)]) await assert.rejects(()=>lib.resolveEntryMedia({status:'running',approval:{at:'synthetic'},material:'other',media:[{type:'image',mediaId:id}]}));
});
test('квота и файлы секретов отклоняются без публикации',async()=>{
 const secret=path.join(dir,'.env.local');writeFileSync(secret,'synthetic');await assert.rejects(()=>lib.importMedia(secret,{material:'case:test',source:'operator'}));
 const f=path.join(dir,'quota.jpg');writeFileSync(f,'large');await assert.rejects(()=>lib.importMedia(f,{material:'case:quota',source:'operator',quotaBytes:1}),/квот/);
});
test('готовая разрешённая версия даёт общий URL, порядок и coverMediaId сохраняются',async()=>{
 const file=path.join(dir,'delivery.jpg');writeFileSync(file,'delivery');
 const orig=await lib.importMedia(file,{material:'case:delivery',source:'operator'});
 const pub=await lib.importMedia(file,{material:'case:delivery',source:'operator',role:'publication',parent:orig.mediaId});
 lib.adoptPublic(pub.mediaId,'https://example.org/delivery.jpg',{confirmed:true});
 const result=await lib.resolveEntryMedia({status:'running',approval:{at:'synthetic'},material:'case:delivery',media:[{type:'image',mediaId:pub.mediaId,coverMediaId:pub.mediaId}]},{head:async()=>new Response(null,{status:200})});
 assert.equal(result.media[0].url,'https://example.org/delivery.jpg');assert.equal(result.media[0].cover,'https://example.org/delivery.jpg');
 await assert.rejects(()=>lib.resolveEntryMedia({status:'running',approval:{at:'synthetic'},material:'case:delivery',media:[{type:'image',mediaId:pub.mediaId}]},{head:async()=>new Response(null,{status:403})}),/недоступ/);
});
test('S3-подпись создаётся при выпуске, срок не хранится в очереди; старые записи совместимы',async()=>{
 const e={status:'draft',media:[{type:'image',url:'https://example.org/legacy.jpg'}]};assert.equal(await lib.resolveEntryMedia(e),e);
 const {presignGet}=await import('../src/media/object-store.mjs');
 const url=presignGet({endpoint:'https://s3.example.org',bucket:'private',key:'publications/a.jpg',accessKey:'synthetic',secretKey:'synthetic',region:'ru-1',now:new Date('2026-11-05T00:00:00Z'),expires:604800});
 assert.equal(new URL(url).searchParams.get('X-Amz-Expires'),'604800');assert.ok(new URL(url).searchParams.has('X-Amz-Signature'));
 assert.throws(()=>presignGet({endpoint:'https://s3.example.org',bucket:'private',key:'a',accessKey:'x',secretKey:'x',region:'ru-1',expires:604801}));
});
test('проверяемое восстановление: повреждение не принимается, существующий файл не затирается',async()=>{
 const {downloadVerified}=await import('../src/media/object-store.mjs');const old=globalThis.fetch;
 const target=path.join(dir,'restored-blob'),data=Buffer.from('restore test');
 const row={objectKey:'originals/a',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
 const config={endpoint:'https://s3.example.org',bucket:'private',accessKey:'synthetic',secretKey:'synthetic',region:'ru-1'};
 try{
  globalThis.fetch=async()=>new Response('bad');await assert.rejects(()=>downloadVerified(config,row,target));assert.equal(existsSync(target),false);
  globalThis.fetch=async()=>new Response(data);await downloadVerified(config,row,target);assert.deepEqual(readFileSync(target),data);
  await assert.rejects(()=>downloadVerified(config,row,target),/существующего/);
 }finally{globalThis.fetch=old;}
});
test('подмена mediaId меняет согласуемый отпечаток, неизвестная версия закрыта до согласования',async()=>{
 const {contentHash,normalize}=await import('../src/queue/format.mjs');
 const base={channel:'telegram',kind:'post',name:'library-case',material:'case:test',text:'text',media:[{type:'image',mediaId:'med_'+'a'.repeat(32)}]};
 const a=normalize(base),b=normalize({...base,media:[{type:'image',mediaId:'med_'+'b'.repeat(32)}]});assert.notEqual(contentHash(a),contentHash(b));
 assert.ok(lib.mediaRefComplaints(a).length);
});
test('два разных кадра одного материала не становятся версиями друг друга',async()=>{
 const a=path.join(dir,'frame-a.jpg'),b=path.join(dir,'frame-b.jpg');writeFileSync(a,'a');writeFileSync(b,'b');
 const first=await lib.importMedia(a,{material:'case:frames',source:'operator'}),second=await lib.importMedia(b,{material:'case:frames',source:'operator'});
 assert.equal(first.version,1);assert.equal(second.version,1);assert.equal(second.supersedes,null);
 const p1=await lib.importMedia(a,{material:'case:frames',source:'operator',role:'publication',variant:'telegram',parent:first.mediaId});
 const p2=await lib.importMedia(b,{material:'case:frames',source:'operator',role:'publication',variant:'telegram',parent:second.mediaId});
 assert.equal(p1.version,1);assert.equal(p2.version,1);assert.notEqual(p1.asset,p2.asset);
});
