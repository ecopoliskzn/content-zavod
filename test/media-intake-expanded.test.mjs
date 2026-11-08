// Расширение служебного процесса: только синтетические авторы/файлы, без внешних вызовов.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const root=mkdtempSync(path.join(tmpdir(),'intake-expanded-'));process.env.DATA_DIR=root;process.env.ZAVOD_ENV_FILE=path.join(root,'absent.env');
const {createIntake}=await import('../src/bot/media-intake.mjs');
const t=(channel,format,rest={})=>({channel,format,account_ref:'own-'+channel,delivery_mode:'auto',readiness:'passed',verified_at:'2026-11-08T00:00:00Z',...rest});
const base={enabled:true,groupId:'-1001',topicId:309,authors:['11'],coordinators:[],coordinatorMode:'operator-admin',approvers:['22'],handoffMode:'B',policyVersion:'test',quietMs:0,limits:{maxFiles:10,maxBytes:20000000,maxPending:20,maxText:4000,maxJobInput:30000,maxJobOutput:20000,maxCalls:4}};
function fixture(targets){return createIntake({dir:mkdtempSync(path.join(root,'case-')),config:{...base,targets},verifyResult:()=>true,telegram:async()=>({ok:true,messageId:500}),importFile:async f=>({verified:true,readable:true,mediaId:'med_'+f.fileUniqueId,sha256:'a'.repeat(64),bytes:10,mime:f.kind==='video'?'video/mp4':'image/jpeg'})});}
let seq=1;
const message=(text,file)=>({update_id:++seq,message:{message_id:seq,chat:{id:-1001},from:{id:11},message_thread_id:309,...(file?{caption:text,...file}:{text})}});
const picture=id=>({photo:[{file_id:'f'+id,file_unique_id:'p'+id,file_size:10}]});
const movie=id=>({video:{file_id:'v'+id,file_unique_id:'v'+id,file_size:10}});
async function confirm(app,id){app.edit(id,app.show(id).revision,'11',{rights:true});return app.prepare(id,app.show(id).revision,'11');}
test('новое текстовое сообщение даёт задание без медиа, а не теряется',async()=>{
 const app=fixture([t('telegram','text'),t('threads','thread'),t('dzen','article')]);assert.equal((await app.handleUpdate(message('Описание без фотографии'))).accepted,true);
 const id=app.list()[0].id;assert.equal((await confirm(app,id)).ok,true);const j=app.jobs()[0];assert.equal(j.recipient,'S1');assert.equal(j.input.files.length,0);assert.equal(app.readiness(id).P3.result,'not_applicable');
 const lease=app.claim(j.id,'S1','a'.repeat(32)),value={inputHash:j.inputHash,variants:j.targets.map(x=>({channel:x.channel,format:x.format,text:'Текст',mediaIds:[],entry:{text:'Текст'}}))};assert.equal(app.result(j.id,'S1',lease.token,value).ok,true);
});
test('видео выбирает совместимые форматы и получателя S2; S1 не крадёт claim',async()=>{
 const app=fixture([t('telegram','album'),t('youtube','short'),t('rutube','video',{delivery_mode:'manual'})]);await app.handleUpdate(message('Описание ролика',movie(1)));const id=app.list()[0].id;
 assert.equal((await confirm(app,id)).ok,true);const j=app.jobs()[0];assert.deepEqual(j.targets.map(x=>x.channel),['youtube','rutube']);assert.equal(j.recipient,'S2');assert.equal(app.claim(j.id,'S1','b'.repeat(32)).ok,false);assert.equal(app.claim(j.id,'S2','b'.repeat(32)).ok,true);
});
test('карусель и сторис одного Instagram не сливаются в один вариант',async()=>{
 const app=fixture([t('instagram','carousel'),t('instagram','story')]);const a=message('Описание',picture(1));a.message.media_group_id='album';await app.handleUpdate(a);const b=message('',picture(2));b.message.media_group_id='album';await app.handleUpdate(b);const id=app.list()[0].id;
 // Для story нужен явный выбор одного кадра; без него не объявляем весь набор готовым.
 app.edit(id,app.show(id).revision,'11',{targetAssets:{'instagram:story':['p1']}});
 assert.equal((await confirm(app,id)).ok,true);const j=app.jobs()[0];assert.equal(j.targets.length,2);assert.equal(j.input.targetMedia['instagram:story'].length,1);assert.equal(j.input.targetMedia['instagram:carousel'].length,2);
 const c=app.claim(j.id,'S1','c'.repeat(32)),v={inputHash:j.inputHash,variants:j.targets.map(x=>({channel:x.channel,format:x.format,text:'Подпись',mediaIds:j.input.targetMedia[x.channel+':'+x.format],entry:{}}))};assert.equal(app.result(j.id,'S1',c.token,v).ok,true);
});
test('not_ready не выглядит готовым, фото не создаёт video job',async()=>{
 const app=fixture([t('youtube','video',{readiness:'not_ready',reason:'нет проверенного доступа'})]);await app.handleUpdate(message('Описание',picture(1)));const id=app.list()[0].id;assert.equal((await confirm(app,id)).ok,false);assert.match(app.card(id).text,/нет проверенного доступа|нет подходящих/i);
});
test('срок задаётся ответом без LLM и без перегенерации текста',async()=>{
 const app=fixture([t('telegram','text')]);await app.handleUpdate(message('Описание'));const id=app.list()[0].id;
 const press=async action=>app.handleUpdate({update_id:++seq,callback_query:{id:'c'+seq,from:{id:11},data:`mi:${id}:${app.show(id).revision}:${action}`,message:{message_id:500,chat:{id:-1001},message_thread_id:309}}});
 await press('time-at');const response=message('09.11.2026 14:30');response.message.reply_to_message={message_id:500};await app.handleUpdate(response);assert.equal(app.show(id).timing.at,'2026-11-09T11:30:00.000Z');assert.equal(app.show(id).brief,'Описание');assert.match(app.card(id).text,/Москва|МСК/);
});
