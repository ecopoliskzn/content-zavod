import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
const isolation=mkdtempSync(path.join(tmpdir(),'yt-intake-preflight-'));process.env.DATA_DIR=isolation;process.env.ZAVOD_ENV_FILE=path.join(isolation,'absent.env');
const {preflightIntakeYoutube,createIntakeYoutubeTransport}=await import('../src/video/intake-preflight.mjs');
const {contentHash}=await import('../src/queue/format.mjs');
function fixture(){
 const dir=mkdtempSync(path.join(isolation,'case-')),bytes=Buffer.from('synthetic approved publication video'),sha256=createHash('sha256').update(bytes).digest('hex'),file=path.join(dir,'video.mp4');writeFileSync(file,bytes);
 const mediaId='med_'+'2'.repeat(32),material='intake:'+'a'.repeat(16),row={mediaId,material,role:'publication',parent:'med_'+'1'.repeat(32),mime:'video/mp4',sha256,bytes:bytes.length};
 let entry={id:'entry1',channel:'youtube',kind:'video',name:'mi-'+ 'a'.repeat(16)+'-1',material,title:'Монтаж покрытия',text:'Монтаж покрытия на объекте.',media:[{type:'video',mediaId}],status:'approved'};
 const approve=()=>{entry.contentHash=contentHash(entry);entry.approval={at:'2026-11-08T10:00:00Z',cardHash:entry.contentHash,card:{messageId:1},actionToken:'current'};};approve();
 const calls=[],video={id:'Abcdefghi12',status:{privacyStatus:'private'},snippet:{}};let uploaded=false,lost=false;
 const transport={start:async payload=>{calls.push(['start',payload]);return{session:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic'};},probe:async()=>{calls.push(['probe']);return uploaded?{id:video.id}:{offset:0};},send:async()=>{calls.push(['send']);uploaded=true;if(lost){lost=false;throw Error('ACK lost');}return{id:video.id};}};
 const api={status:async()=>{calls.push(['status']);return{kind:'ok',privacy:'private',publishAt:'',raw:video};},updateSnippet:async(id,payload)=>{calls.push(['update',payload]);video.snippet=payload;return{ok:true};},setThumbnail:async()=>({ok:true}),setSchedule:async()=>({ok:true})};
 const options={dir,getEntry:()=>structuredClone(entry),patchEntry:async(id,fields)=>{calls.push(['patch']);entry={...entry,...fields};return entry;},isCurrent:()=>true,halted:()=>false,catalog:()=>[row],localPath:()=>file,describe:e=>e.text,transport,api};
 return{dir,file,row,bytes,calls,options,get entry(){return entry;},approve,setLost:()=>{lost=true;},run:()=>preflightIntakeYoutube(entry,options)};
}
test('до актуального одобрения загрузки нет; после него private без publishAt и один id',async()=>{
 const f=fixture();f.entry.status='review';assert.equal((await f.run()).ready,false);assert.equal(f.calls.length,0);
 f.entry.status='approved';assert.equal((await f.run()).ready,true);assert.equal(f.entry.extra.youtubeId,'Abcdefghi12');assert.equal(f.entry.extra.youtubeHash,f.entry.contentHash);
 const request=f.calls.find(c=>c[0]==='start')[1];assert.equal(request.status.privacyStatus,'private');assert.equal(request.status.publishAt,undefined);
 await f.run();assert.equal(f.calls.filter(c=>c[0]==='start').length,1);assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
});
test('потерянный ACK завершается сверкой той же сессии, не повторной загрузкой',async()=>{
 const f=fixture();f.setLost();assert.equal((await f.run()).ready,false);assert.equal((await f.run()).ready,true);
 assert.equal(f.calls.filter(c=>c[0]==='start').length,1);assert.equal(f.calls.filter(c=>c[0]==='send').length,1);assert.ok(f.calls.some(c=>c[0]==='probe'));
});
test('новое одобренное описание обновляет тот же закрытый ролик',async()=>{
 const f=fixture();assert.equal((await f.run()).ready,true);f.entry.text='На объекте завершили укладку покрытия.';f.approve();
 assert.equal((await f.run()).ready,true);assert.equal(f.calls.filter(c=>c[0]==='start').length,1);assert.equal(f.calls.filter(c=>c[0]==='update').at(-1)[1].description,f.entry.text);assert.equal(f.entry.extra.youtubeHash,f.entry.contentHash);
});
test('повреждённые байты и смена согласия во время загрузки не дают ready',async()=>{
 const f=fixture();writeFileSync(f.file,'corrupt');assert.equal((await f.run()).ready,false);assert.equal(f.calls.length,0);
 writeFileSync(f.file,f.bytes);const send=f.options.transport.send;f.options.transport.send=async(...args)=>{const r=await send(...args);f.entry.status='rework';return r;};
 assert.equal((await f.run()).ready,false);assert.equal(f.entry.extra,undefined);assert.equal(f.calls.filter(c=>c[0]==='start').length,1);
});
test('потеря ACK записи extra не создаёт второй ролик',async()=>{
 const f=fixture(),patch=f.options.patchEntry;let lost=true;
 f.options.patchEntry=async(...args)=>{const r=await patch(...args);if(lost){lost=false;throw Error('queue ACK lost');}return r;};
 assert.equal((await f.run()).ready,false);assert.equal((await f.run()).ready,true);assert.equal(f.calls.filter(c=>c[0]==='start').length,1);assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
});
test('STOP, чужой target и неверный hash не дают внешних эффектов',async()=>{
 for(const block of ['stop','target','hash']){const f=fixture();if(block==='stop')f.options.halted=()=>true;if(block==='target')f.options.isCurrent=()=>false;if(block==='hash')f.entry.approval.cardHash='other';assert.equal((await f.run()).ready,false);assert.equal(f.calls.length,0);}
});
test('неизвестный старт и истёкшая сессия не запускают новый insert',async()=>{
 const a=fixture();a.options.transport.start=async()=>{a.calls.push(['start']);throw Error('lost session ACK');};await a.run();assert.equal((await a.run()).status,'unknown');assert.equal(a.calls.filter(c=>c[0]==='start').length,1);
 const b=fixture();b.setLost();await b.run();b.options.transport.probe=async()=>({unknown:true,reason:'session_expired'});assert.equal((await b.run()).reason,'session_expired');assert.equal(b.calls.filter(c=>c[0]==='start').length,1);
});
test('реальный resumable-клиент использует private POST, status PUT и точный Content-Range',async()=>{
 const calls=[],session='https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic';
 const transport=createIntakeYoutubeTransport({token:async()=>({kind:'ok',token:'synthetic-token'}),fetchImpl:async(url,init)=>{calls.push({url,init});if(init.method==='POST')return new Response('',{status:200,headers:{location:session}});if(init.headers['content-length']==='0')return new Response(null,{status:308,headers:{range:'bytes=0-2'}});return Response.json({id:'Abcdefghi12'},{status:201});}});
 assert.equal((await transport.start({snippet:{title:'Монтаж'},status:{privacyStatus:'public',publishAt:'2030-01-01T00:00:00Z'},mime:'video/mp4',size:6})).session,session);
 assert.equal(JSON.parse(calls[0].init.body).status.privacyStatus,'private');assert.equal(JSON.parse(calls[0].init.body).status.publishAt,undefined);
 assert.deepEqual(await transport.probe(session,6),{offset:3});assert.deepEqual(await transport.send(session,Buffer.from('abcdef'),3,'video/mp4'),{id:'Abcdefghi12'});
 assert.equal(calls[1].init.headers['content-range'],'bytes */6');assert.equal(calls[2].init.headers['content-range'],'bytes 3-5/6');assert.equal(calls[2].init.body.toString(),'def');assert.equal(calls[0].init.redirect,'error');
 await assert.rejects(()=>transport.probe('https://example.org/steal',6));assert.equal(calls.length,3);
});
test('обложка сверяется по байтам, MIME и тому же parent до внешних эффектов',async()=>{
 const f=fixture(),bytes=Buffer.from('synthetic cover'),file=path.join(f.dir,'cover.png');writeFileSync(file,bytes);
 const cover={...f.row,mediaId:'med_'+'3'.repeat(32),role:'cover',mime:'image/png',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 f.entry.media[0].coverMediaId=cover.mediaId;f.approve();f.options.catalog=()=>[f.row,cover];f.options.localPath=r=>r.mediaId===cover.mediaId?file:f.file;
 cover.parent='other';assert.equal((await f.run()).ready,false);assert.equal(f.calls.length,0);cover.parent=f.row.parent;
 let received=false;f.options.api.setThumbnail=async(id,local)=>{assert.equal(id,'Abcdefghi12');assert.deepEqual(readFileSync(local),bytes);assert.equal(path.extname(local),'.png');received=true;return{ok:true};};
 assert.equal((await f.run()).ready,true);assert.equal(received,true);
 writeFileSync(file,'bad');assert.equal((await f.run()).ready,false);
});
test('после потери ACK открытия ready-квитанция разрешает только сверку уже публичного ролика',async()=>{
 const f=fixture();assert.equal((await f.run()).ready,true);const status=f.options.api.status;
 f.options.api.status=async()=>({...await status(),privacy:'public'});const updates=f.calls.filter(c=>c[0]==='update').length;
 assert.equal((await f.run()).status,'already_public');assert.equal(f.calls.filter(c=>c[0]==='update').length,updates);assert.equal(f.calls.filter(c=>c[0]==='start').length,1);
 f.entry.text='Исправленный текст';f.approve();assert.equal((await f.run()).ready,false);
});
test('известный отказ до создания сессии допускает штатное продолжение после исправления доступа',async()=>{
 const f=fixture(),start=f.options.transport.start;let refused=true;
 f.options.transport.start=async p=>{if(refused){refused=false;return{notStarted:true,reason:'youtube_auth'};}return start(p);};
 assert.equal((await f.run()).status,'pending');assert.equal((await f.run()).ready,true);assert.equal(f.calls.filter(c=>c[0]==='start').length,1);
 let requests=0;const transport=createIntakeYoutubeTransport({token:async()=>({kind:'refused'}),fetchImpl:async()=>{requests++;}});
 assert.equal((await transport.start({snippet:{},status:{},mime:'video/mp4',size:1})).notStarted,true);assert.equal(requests,0);
});
