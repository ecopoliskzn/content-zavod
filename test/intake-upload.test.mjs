import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {createServer} from 'node:http';
process.env.ZAVOD_ENV_FILE=path.join(tmpdir(),'absent-upload.env');
const {intakeUploadLink,handleIntakeUpload}=await import('../src/media/intake-upload.mjs');
test('закрытая загрузка: токен во fragment, chunks/idempotency, один импорт и отзыв после замены состава',async()=>{
 const id='a'.repeat(16),f={fileUniqueId:'synthetic-video',size:16,mime:'video/mp4',kind:'video',status:'failed'},material={id,revision:1,manifest_revision:1,mode:'draft',files:[f]},now=Date.parse('2026-11-10T15:00:00Z');let imports=0,attaches=0;
 const app={show:value=>value===id?structuredClone(material):null,refreshCards:()=>({ok:true})},opts={app,root:mkdtempSync(path.join(tmpdir(),'upload-')),secret:'synthetic-upload-key',base:'https://origin.example',clock:()=>now,capacity:()=>({freeBytes:2e9,bytes:0,quotaBytes:1e9}),validate:async()=>{},importer:async()=>{imports++;return{mediaId:'med_'+'c'.repeat(32),bytes:16,sha256:'d'.repeat(64)};},attach:async()=>{attaches++;f.status='verified';f.mediaId='med_'+'c'.repeat(32);material.manifest_revision++;return{ok:true};}};
 const link=new URL(intakeUploadLink(material,f,{secret:opts.secret,base:opts.base,now}));assert.ok(link.hash);assert.equal(link.search,'');
 const server=createServer((req,res)=>void handleIntakeUpload(req,res,opts));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+link.pathname,headers={authorization:'Bearer '+link.hash.slice(1)};
 try{
  assert.equal((await fetch(base+'/status')).status,403);assert.equal((await fetch(base)).status,200);
  assert.equal((await fetch(base+'/status',{headers:{...headers,origin:'https://other.example'}})).status,403);
  assert.equal((await fetch(base+'/finish',{method:'POST',headers})).status,409);
  const bytes=Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]);
  let r=await fetch(base+'/chunk',{method:'PUT',headers:{...headers,'x-upload-offset':'0','x-file-fingerprint':'e'.repeat(64)},body:bytes});assert.equal(r.status,200);
  r=await fetch(base+'/chunk',{method:'PUT',headers:{...headers,'x-upload-offset':'0','x-file-fingerprint':'e'.repeat(64)},body:bytes});assert.equal(r.status,200);assert.equal((await r.json()).received,16);
  assert.equal((await fetch(base+'/chunk',{method:'PUT',headers:{...headers,'x-upload-offset':'0','x-file-fingerprint':'f'.repeat(64)},body:bytes})).status,409);
  assert.equal((await fetch(base+'/chunk',{method:'PUT',headers:{...headers,'x-upload-offset':'0','x-file-fingerprint':'e'.repeat(64)},body:Buffer.alloc(17)})).status,413);
  assert.equal((await fetch(base+'/finish',{method:'POST',headers})).status,200);assert.equal((await fetch(base+'/finish',{method:'POST',headers})).status,200);assert.equal(imports,1);assert.equal(attaches,1);
  material.mode='cancelled';assert.equal((await fetch(base+'/status',{headers})).status,403);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('потерянный ответ после привязки оригинала восстанавливается без второго импорта и согласия',async()=>{
 const id='b'.repeat(16),f={fileUniqueId:'fixture',size:16,mime:'video/mp4',status:'failed'},material={id,revision:1,manifest_revision:1,mode:'draft',files:[f]},now=Date.now();let imports=0,attaches=0;
 const opts={app:{show:()=>structuredClone(material)},root:mkdtempSync(path.join(tmpdir(),'upload-ack-')),secret:'synthetic-key',base:'https://origin.example',clock:()=>now,capacity:()=>({freeBytes:2e9,bytes:0,quotaBytes:1e9}),validate:async()=>{},importer:async()=>{imports++;return{mediaId:'med_'+'d'.repeat(32)};},attach:async()=>{attaches++;f.status='verified';f.mediaId='med_'+'d'.repeat(32);material.manifest_revision++;throw Error('simulated lost acknowledgement');}};
 const link=new URL(intakeUploadLink(material,f,{secret:opts.secret,base:opts.base,now})),server=createServer((req,res)=>void handleIntakeUpload(req,res,opts));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+link.pathname,headers={authorization:'Bearer '+link.hash.slice(1)};
 try{assert.equal((await fetch(base+'/chunk',{method:'PUT',headers:{...headers,'x-upload-offset':'0','x-file-fingerprint':'e'.repeat(64)},body:Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0])})).status,200);assert.equal((await fetch(base+'/finish',{method:'POST',headers})).status,503);const status=await fetch(base+'/status',{headers});assert.equal((await status.json()).status,'complete');assert.equal((await fetch(base+'/finish',{method:'POST',headers})).status,200);assert.equal(imports,1);assert.equal(attaches,1);assert.equal(material.mode,'draft');}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
