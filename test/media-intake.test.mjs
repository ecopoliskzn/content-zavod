// Служебный приём проверяется на вымышленных событиях в отдельной папке, без сети и ключей.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createIntake} from '../src/bot/media-intake.mjs';
const isolation=mkdtempSync(path.join(tmpdir(),'intake-env-'));process.env.ZAVOD_ENV_FILE=path.join(isolation,'absent.env');process.env.DATA_DIR=isolation;

const config={enabled:true,groupId:'-100123',topicId:9,authors:['11'],coordinators:['22'],approvers:['33'],handoffMode:'B',
 targets:[{channel:'telegram',account_ref:'own-tg',format:'album',delivery_mode:'auto',readiness:'passed',verified_at:'2026-11-07T10:00:00Z'},
 {channel:'instagram',account_ref:'own-ig',format:'carousel',delivery_mode:'auto',readiness:'passed',verified_at:'2026-11-07T10:00:00Z'}],
 limits:{maxFiles:10,maxBytes:20_000_000,maxPending:20,maxText:4000,maxJobInput:20000,maxJobOutput:10000,maxCalls:4},
 policyVersion:'pilot-1',rightsPolicy:null,quietMs:0};
function fixture(extra={}) {const dir=mkdtempSync(path.join(tmpdir(),'intake-test-'));let sends=0,imports=0;const cards=[];
 const app=createIntake({dir,config,clock:()=>Date.parse('2026-11-07T10:00:00Z'),verifyResult:()=>true,
 importFile:async a=>{imports++;return{mediaId:'med_'+a.fileUniqueId,sha256:'a'.repeat(64),bytes:12,mime:'image/jpeg',verified:true,readable:true};},
 telegram:async(method,body)=>{cards.push({method,body});if(method==='sendMessage')sends++;return{ok:true,messageId:100+sends};},...extra});
 return{app,dir,cards,counts:()=>({sends,imports})};}
const photo=(id=1,album='a')=>({update_id:id,message:{message_id:id,chat:{id:-100123,type:'supergroup'},message_thread_id:9,from:{id:11},media_group_id:album,caption:id===1?'Показать объект. Описание автора.':'',photo:[{file_id:'f'+id,file_unique_id:'u'+id,file_size:12,width:100,height:100}]}});
let callbackSequence=1000;
const cb=(app,id,action,rev,from=11)=>({update_id:++callbackSequence,callback_query:{id:'c'+callbackSequence,from:{id:from},data:`mi:${id}:${rev}:${action}`,message:{message_id:app.show(id).card.messageId,chat:{id:-100123},message_thread_id:9}}});
async function ready(f) {await f.app.handleUpdate(photo());const id=f.app.list()[0].id;await f.app.handleUpdate(cb(f.app,id,'rights',f.app.show(id).revision));await f.app.handleUpdate(cb(f.app,id,'prepare',f.app.show(id).revision));return id;}

test('повтор update, альбом и document: один комплект, порядок, одна карточка; состояние переживает рестарт',async()=>{
 const f=fixture();await f.app.handleUpdate(photo(2));await f.app.handleUpdate(photo(1));await f.app.handleUpdate(photo(1));
 const p=photo(3);delete p.message.photo;p.message.document={file_id:'d',file_unique_id:'ud',file_size:12,mime_type:'image/jpeg',file_name:'picture.jpg'};await f.app.handleUpdate(p);
 assert.equal(f.app.list().length,1);const row=f.app.show(f.app.list()[0].id);assert.deepEqual(row.files.map(x=>x.messageId),[1,2,3]);assert.equal(row.files.length,3);assert.equal(f.counts().sends,1);assert.equal(f.counts().imports,3);
 const next=createIntake({dir:f.dir,config});assert.equal(next.show(row.id).files.length,3);assert.equal(next.readiness(row.id).P3.result,'passed');
});
test('не та группа, чужая роль и старая кнопка не меняют задание',async()=>{
 const f=fixture();const wrong=photo();wrong.message.chat.id=-100999;assert.equal(f.app.ingest(wrong).accepted,false);
 await f.app.handleUpdate(photo());const id=f.app.list()[0].id,rev=f.app.show(id).revision;
 await f.app.handleUpdate(cb(f.app,id,'rights',rev,99));assert.equal(f.app.show(id).rights.status,'needs_clarification');
 await f.app.handleUpdate(cb(f.app,id,'rights',rev));await f.app.handleUpdate(cb(f.app,id,'prepare',rev));assert.equal(f.app.jobs().length,0);
});
test('неполный импорт блокирует P3/P4: исключение только явно и с новой версией',async()=>{
 const f=fixture({importFile:async a=>{if(a.fileUniqueId==='u2')throw Object.assign(Error('secret URL must not escape'),{code:'TOO_LARGE'});return{mediaId:'med_x',sha256:'a'.repeat(64),bytes:12,mime:'image/jpeg',verified:true,readable:true};}});
 await f.app.handleUpdate(photo());await f.app.handleUpdate(photo(2));const id=f.app.list()[0].id;
 assert.equal(f.app.readiness(id).P3.result,'blocked');assert.match(f.app.card(id).text,/1 из 2/);assert.ok(!JSON.stringify(f.app.show(id)).includes('secret URL'));
 f.app.edit(id,f.app.show(id).revision,'11',{excludeFile:'u2'});await f.app.flush();
 await f.app.handleUpdate(cb(f.app,id,'rights',f.app.show(id).revision));await f.app.handleUpdate(cb(f.app,id,'prepare',f.app.show(id).revision));assert.equal(f.app.readiness(id).P4.result,'passed');assert.equal(f.app.readiness(id).P9.result,'blocked');
});
test('Подготовить так не Одобрить; claim один, повтор результата идемпотентен и только текущая версия',async()=>{
 const f=fixture();const id=await ready(f),job=f.app.jobs()[0];assert.equal(f.app.readiness(id).P4.result,'passed');assert.equal(f.app.readiness(id).P5.result,'blocked');
 const lease=f.app.claim(job.id,'S1');assert.equal(f.app.claim(job.id,'S2').ok,false);assert.equal(f.app.readiness(id).P5.result,'passed');
 const result={inputHash:job.inputHash,variants:job.targets.map(t=>({channel:t.channel,format:t.format,text:'Черновик без новых фактов',mediaIds:['med_u1']})),editorialReview:{result:'passed',policyVersion:'pilot-1'}};
 assert.equal(f.app.result(job.id,'S1',lease.token,result).ok,true);assert.equal(f.app.result(job.id,'S1',lease.token,result).duplicate,true);assert.equal(f.app.readiness(id).P9.result,'blocked');
});
test('поздний файл после передачи создаёт ревизию, старый result отвергается, новый job ждёт владельца',async()=>{
 const f=fixture();const id=await ready(f),j=f.app.jobs()[0],lease=f.app.claim(j.id,'S1');await f.app.handleUpdate(photo(2));
 assert.equal(f.app.result(j.id,'S1',lease.token,{inputHash:j.inputHash,variants:[]}).ok,false);assert.equal(f.app.show(id).rights.status,'needs_clarification');
 assert.equal(f.app.jobs().filter(x=>x.status==='queued').length,0);assert.match(f.app.card(id).text,/состав изменён/i);
});
test('таймаут создания карточки не шлёт вторую; требуется явная сверка',async()=>{
 let calls=0;const f=fixture({telegram:async()=>{calls++;return{ok:false,uncertain:true};}});await f.app.handleUpdate(photo());await f.app.flush();assert.equal(calls,1);assert.equal(f.app.show(f.app.list()[0].id).card.status,'unknown');
});
test('архив и отмена не создают jobs; нельзя молча принять ответ в чужой теме',async()=>{
 const f=fixture();await f.app.handleUpdate(photo());const id=f.app.list()[0].id;
 const other=cb(f.app,id,'archive',f.app.show(id).revision);other.callback_query.message.message_thread_id=8;await f.app.handleUpdate(other);assert.equal(f.app.show(id).mode,'draft');
 await f.app.handleUpdate(cb(f.app,id,'archive',f.app.show(id).revision));assert.equal(f.app.show(id).mode,'archive');assert.equal(f.app.jobs().length,0);
});
test('файл с одинаковым unique_id в другом сообщении сохраняет источник без повторного импорта',async()=>{
 const f=fixture();await f.app.handleUpdate(photo());const duplicate=photo(2);duplicate.message.photo[0].file_unique_id='u1';await f.app.handleUpdate(duplicate);const r=f.app.show(f.app.list()[0].id);assert.equal(r.files.length,1);assert.equal(r.files[0].messages.length,2);assert.equal(f.counts().imports,1);
});
test('повреждённое состояние не превращается в пустое и не теряет дедуп',()=>{
 const f=fixture();f.app.ingest(photo());writeFileSync(path.join(f.dir,'state.json'),'{broken');assert.throws(()=>f.app.list(),/состояние/);
});
test('LLM/публикация не вызываются обработкой файлов и кнопок; бюджет обязателен для job',async()=>{
 const f=fixture({config:{...config,limits:{...config.limits,maxCalls:0}}});await f.app.handleUpdate(photo());const id=f.app.list()[0].id;await f.app.handleUpdate(cb(f.app,id,'rights',f.app.show(id).revision));await f.app.handleUpdate(cb(f.app,id,'prepare',f.app.show(id).revision));assert.equal(f.app.jobs().length,0);assert.ok(f.app.readiness(id).P4.blockers.some(b=>b.reason_code==='budget_unset'));assert.ok(f.cards.every(x=>['sendMessage','editMessageText','answerCallbackQuery'].includes(x.method)));
});
test('после kill умершего владельца state/worker lock восстанавливается; живой не отбирается',async()=>{
 const f=fixture();const {intakeLock}=await import('../src/bot/media-intake-store.mjs');
 const own=intakeLock(path.join(f.dir,'state.lock'));assert.throws(()=>f.app.ingest(photo()),/занят/);own();
 for(const name of ['state.lock','worker.lock']){
  const file=path.join(f.dir,name),module=new URL('../src/bot/media-intake-store.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {intakeLock} from ${JSON.stringify(module)}; intakeLock(${JSON.stringify(file)}); console.log('ready'); setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe'],env:process.env});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  if(name==='state.lock')assert.equal(f.app.ingest(photo()).accepted,true);else assert.equal((await f.app.flush()).ok,true);
 }
});
test('release устаревшего claim открывает путь новой версии без таймерного двойного исполнителя',async()=>{
 const f=fixture();const id=await ready(f),j=f.app.jobs()[0],old=f.app.claim(j.id,'S1');await f.app.handleUpdate(photo(2));
 await f.app.handleUpdate(cb(f.app,id,'rights',f.app.show(id).revision));await f.app.handleUpdate(cb(f.app,id,'prepare',f.app.show(id).revision));
 const next=f.app.jobs().find(x=>x.revision===f.app.show(id).revision);assert.equal(f.app.claim(next.id,'S2').ok,false);
 assert.equal(f.app.release(j.id,'S1',old.token).status,'superseded');assert.equal(f.app.claim(next.id,'S2').ok,true);
});
test('подпись HTML экранирована; свой ответ в карточку добавляет описание без чужой переписки',async()=>{
 const f=fixture();const p=photo();p.message.caption='<b>caption</b> & literal';await f.app.handleUpdate(p);const id=f.app.list()[0].id;
 assert.match(f.app.card(id).text,/&lt;b&gt;caption&lt;\/b&gt; &amp;/);
 await f.app.handleUpdate({update_id:55,message:{message_id:55,from:{id:11},chat:{id:-100123},message_thread_id:9,text:'Добавленное описание',reply_to_message:{message_id:f.app.show(id).card.messageId}}});assert.match(f.app.show(id).brief,/Добавленное/);
});
test('архив/отмена/обсуждение не дают API prepare и неверный срок не меняет версию',async()=>{
 for(const mode of ['archive','cancelled','discussion']){const f=fixture(),id=await ready(f);f.app.edit(id,f.app.show(id).revision,'11',{mode});assert.equal(f.app.prepare(id,f.app.show(id).revision,'11').ok,false);}
 const f=fixture();await f.app.handleUpdate(photo());const id=f.app.list()[0].id,rev=f.app.show(id).revision;
 assert.throws(()=>f.app.edit(id,rev,'11',{timing:{mode:'at',at:'2026-99-99T00:00:00Z'}}));assert.equal(f.app.show(id).revision,rev);
 f.app.edit(id,rev,'11',{timing:{mode:'choose_later'}});assert.match(f.app.card(id).text,/отложен/);
});
test('неизвестный размер передаётся импорту как undefined; переполнение очереди и файл-лимит видны',async()=>{
 let size='not-called';const f=fixture({importFile:async a=>{size=a.size;throw Object.assign(Error(),{code:'QUOTA'});}});const p=photo();delete p.message.photo[0].file_size;await f.app.handleUpdate(p);assert.equal(size,undefined);
 const q=fixture({config:{...config,limits:{...config.limits,maxPending:1,maxFiles:1}}});await q.app.handleUpdate(photo());assert.equal(q.app.ingest(photo(7,'new-album')).blocked,true);await q.app.handleUpdate(photo(2));assert.match(q.app.card(q.app.list()[0].id).text,/лимит комплекта/);
});
test('одного LLM JSON без проверяемого артефакта недостаточно для P6',async()=>{
 const f=fixture({verifyResult:undefined}),id=await ready(f),j=f.app.jobs()[0],owner=f.app.claim(j.id,'S1');const result={inputHash:j.inputHash,variants:j.targets.map(t=>({channel:t.channel,format:t.format,text:'Текст',mediaIds:['med_u1']}))};assert.equal(f.app.result(j.id,'S1',owner.token,result).reason,'artifact_verification');assert.equal(f.app.readiness(id).P6.result,'blocked');
});
test('редактор задаёт один конкретный вопрос; отказ от спорного закрывает только его и требует новую передачу',async()=>{
 const f=fixture(),id=await ready(f),j=f.app.jobs()[0],lease=f.app.claim(j.id,'S1');
 assert.equal(f.app.question(j.id,'S1','wrong',{text:'Нет источника'}).ok,false);
 assert.equal(f.app.question(j.id,'S1',lease.token,{text:'Откуда утверждение о гарантии? Можно исключить.',allowOmit:true}).ok,true);
 const q=f.app.show(id).questions[0];assert.match(f.app.card(id).text,/Откуда утверждение/);assert.equal(f.app.prepare(id,f.app.show(id).revision,'11').ok,false);
 await f.app.handleUpdate(cb(f.app,id,'omit-'+q.id,f.app.show(id).revision));assert.equal(f.app.show(id).questions[0].resolution,'omit');assert.equal(f.app.show(id).mode,'draft');
 assert.equal(f.app.release(j.id,'S1',lease.token).ok,true);assert.equal(f.app.prepare(id,f.app.show(id).revision,'11').ok,true);
});
test('после отключения и удаления роли нет новых ответов/импорта, права автора не бессрочные',async()=>{
 let active=structuredClone(config);const f=fixture({config:()=>active});await f.app.handleUpdate(photo());const id=f.app.list()[0].id;
 active={...active,authors:[]};assert.throws(()=>f.app.edit(id,f.app.show(id).revision,'11',{brief:'new'}),/прав/);
 const before=f.counts();active={...active,enabled:false};assert.equal((await f.app.flush()).disabled,true);assert.deepEqual(f.counts(),before);
});
test('боевой verifier требует publication bytes, совпадение payload и запрещает полномочия из результата',async()=>{
 const lib=await import('../src/media/library.mjs'),{verifyIntakeResult}=await import('../src/bot/media-intake-runtime.mjs');
 const file=path.join(isolation,'verified.png');writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=','base64'));
 const materialId='a'.repeat(16),material='intake:'+materialId,original=await lib.importMedia(file,{material,source:'synthetic test'}),pub=await lib.importMedia(file,{material,source:'synthetic test',role:'publication',parent:original.mediaId,variant:'telegram'});
 const job={materialId,revision:1,inputHash:'test',targets:[{channel:'telegram',format:'album'}],input:{policyVersion:'pilot-1',files:[{mediaId:original.mediaId}]}};
 const entry={channel:'telegram',kind:'post',name:`mi-${materialId}-1`,material,date:'2026-11-07',time:'12:00',text:'Покрытие на фото показано общим планом. Рассмотрите рисунок поверхности.',media:[{type:'image',mediaId:pub.mediaId}],facts:[]};
 const value={inputHash:'test',editorialReview:{result:'passed',policyVersion:'pilot-1'},variants:[{channel:'telegram',format:'album',text:entry.text,mediaIds:[pub.mediaId],entry}]};
 assert.equal(verifyIntakeResult(value,job),true);
 const forged=structuredClone(value);forged.variants[0].entry.status='approved';assert.equal(verifyIntakeResult(forged,job),false);
 const mismatch=structuredClone(value);mismatch.variants[0].text='Другой текст';assert.equal(verifyIntakeResult(mismatch,job),false);
 const originalRef=structuredClone(value);originalRef.variants[0].entry.media[0].mediaId=original.mediaId;originalRef.variants[0].mediaIds=[original.mediaId];assert.equal(verifyIntakeResult(originalRef,job),false);
 writeFileSync(lib.blobPath(pub),'corrupted');assert.equal(verifyIntakeResult(value,job),false);writeFileSync(lib.blobPath(pub),readFileSync(file));
});
test('claim квитанция потеряна после серверного успеха: requestId восстанавливает ровно прежнее владение',async()=>{
 const f=fixture(),id=await ready(f),j=f.app.jobs()[0],requestId='1'.repeat(32),first=f.app.claim(j.id,'S1',requestId);
 assert.equal(first.ok,true);
 // Клиент не сохранил ответ и перезапущен. Сервер и intent на диске пережили обрыв.
 const restarted=createIntake({dir:f.dir,config}),again=restarted.claim(j.id,'S1',requestId);
 assert.equal(again.ok,true);assert.equal(again.duplicate,true);assert.equal(again.token,first.token);
 assert.equal(restarted.claim(j.id,'S2',requestId).ok,false);assert.equal(restarted.claim(j.id,'S1','2'.repeat(32)).ok,false);
 assert.equal(restarted.jobs().filter(x=>x.status==='claimed').length,1);
});
test('цифры с источником: вопрос, ответ, сверка факта, release и новый job без автоматического доверия подписи',async()=>{
 const f=fixture();const p=photo();p.message.caption='Описание автора: площадь 250 м².';await f.app.handleUpdate(p);const id=f.app.list()[0].id;
 await f.app.handleUpdate(cb(f.app,id,'rights',f.app.show(id).revision));await f.app.handleUpdate(cb(f.app,id,'prepare',f.app.show(id).revision));const j=f.app.jobs()[0],lease=f.app.claim(j.id,'S1');
 assert.deepEqual(j.input.facts,[]);assert.equal(j.input.sources[0].kind,'author_statement');
 f.app.question(j.id,'S1',lease.token,{text:'Пришлите источник площади',allowOmit:true});
 await f.app.handleUpdate({update_id:77,message:{message_id:77,from:{id:11},chat:{id:-100123},message_thread_id:9,text:'Источник: https://ecopolisrf.ru/cases/example/ — площадь 250 м².',reply_to_message:{message_id:f.app.show(id).card.messageId}}});
 assert.equal(f.app.show(id).questions[0].status,'answered');
 const facts={sources:[{id:'client-case',kind:'client-page',locator:'https://ecopolisrf.ru/cases/example/',text:'Площадь покрытия 250 м².'}],facts:[{claim:'Площадь покрытия 250 м².',sourceId:'client-case',confirmed:true}],resolutions:[{questionId:f.app.show(id).questions[0].id,type:'source',sourceId:'client-case',claims:['Площадь покрытия 250 м².']}]};
 assert.equal(f.app.facts(id,f.app.show(id).revision,j.id,'S1',lease.token,facts).ok,true);assert.equal(f.app.release(j.id,'S1',lease.token).ok,true);
 assert.equal(f.app.prepare(id,f.app.show(id).revision,'11').ok,true);const next=f.app.jobs().at(-1);assert.equal(next.input.facts[0].source,'https://ecopolisrf.ru/cases/example/');assert.equal(next.input.facts[0].claim,'Площадь покрытия 250 м².');assert.equal(f.app.claim(next.id,'S1').ok,true);
});
test('пустая/несвязанная проверка источников не закрывает отвеченный вопрос',async()=>{
 const f=fixture(),id=await ready(f),j=f.app.jobs()[0],lease=f.app.claim(j.id,'S1');f.app.question(j.id,'S1',lease.token,{text:'Уточните происхождение цифры',allowOmit:false});
 await f.app.handleUpdate({update_id:90,message:{message_id:90,from:{id:11},chat:{id:-100123},message_thread_id:9,text:'Не знаю',reply_to_message:{message_id:f.app.show(id).card.messageId}}});
 const q=f.app.show(id).questions[0];assert.equal(q.status,'answered');
 assert.equal(f.app.facts(id,f.app.show(id).revision,j.id,'S1',lease.token,{sources:[],facts:[]}).ok,true);assert.equal(f.app.show(id).questions[0].status,'answered');
 assert.equal(f.app.facts(id,f.app.show(id).revision,j.id,'S1',lease.token,{sources:[],facts:[],resolutions:[{questionId:q.id,type:'source',sourceId:'missing',claims:['unknown']}]}).ok,false);assert.equal(f.app.show(id).questions[0].status,'answered');
});
test('редакторская аннотация источника не требует повторной кнопки автора: реальный формат post с 40 мм → result → review',async()=>{
 const lib=await import('../src/media/library.mjs'),{verifyIntakeResult}=await import('../src/bot/media-intake-runtime.mjs'),{deliverIntakeResults}=await import('../src/bot/media-intake-delivery.mjs');
 const file=path.join(isolation,'workflow.png');writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=','base64'));
 const f=fixture({config:{...config,limits:{...config.limits,maxPending:1},targets:[{...config.targets[0]},{...config.targets[0],channel:'vk',account_ref:'own-vk',format:'photopost'}]},verifyResult:verifyIntakeResult,importFile:async a=>({...await lib.importMedia(file,{material:a.material,source:a.source,variant:a.variant}),verified:true,readable:true})});
 const p=photo();p.message.caption='Длина образца 40 мм. Показать фото образца.';await f.app.handleUpdate(p);const id=f.app.list()[0].id;await f.app.handleUpdate(cb(f.app,id,'rights',f.app.show(id).revision));await f.app.handleUpdate(cb(f.app,id,'prepare',f.app.show(id).revision));
 const j=f.app.jobs()[0],lease=f.app.claim(j.id,'S1','a'.repeat(32)),rev=f.app.show(id).revision;
 const annotation=f.app.facts(id,rev,j.id,'S1',lease.token,{sources:[{id:'client-document',kind:'client-document',locator:'документ клиента: синтетический акт измерения, 07.11.2026',text:'Длина образца 40 мм.'}],facts:[{claim:'Длина образца 40 мм.',sourceId:'client-document',confirmed:true}]});
 assert.equal(annotation.ok,true);assert.equal(f.app.show(id).revision,rev);assert.equal(f.app.show(id).mode,'submitted');assert.notEqual(annotation.inputHash,j.inputHash);
 const latest=f.app.jobs()[0],original=latest.input.files[0],publication=await lib.importMedia(file,{material:'intake:'+id,source:'synthetic derivative',role:'publication',parent:original.mediaId,variant:'approved-later'});
 const text='Образец длиной 40 мм показан на фото. Рассмотрите его поверхность.';
 const value={inputHash:latest.inputHash,editorialReview:{result:'passed',policyVersion:'pilot-1'},variants:latest.targets.map(t=>({channel:t.channel,format:t.format,text,mediaIds:[publication.mediaId],entry:{channel:t.channel,kind:'post',name:`mi-${id}-${rev}`,material:'intake:'+id,text,media:[{type:'image',mediaId:publication.mediaId}],facts:latest.input.facts,date:'2026-11-07',time:'12:00'}}))};
 assert.equal(f.app.result(j.id,'S1',lease.token,value).ok,true);
 const queue=new Map(),{normalize,contentHash}=await import('../src/queue/format.mjs');
 const sent=await deliverIntakeResults(f.app,{getEntry:id=>queue.get(id),executeQueue:async(cmd,args)=>{if(cmd==='add'){const e=normalize(args.entries);queue.set(e.id,{...e,status:'draft',contentHash:contentHash(e)});}else{const e=queue.get(args.ref);e.status='review';e.approval={card:{messageId:500}};}return{code:0};}});
 assert.equal(sent.submitted,2);assert.ok([...queue.values()].every(e=>e.status==='review'));assert.equal(f.app.readiness(id).P9.result,'blocked');
 const {syncIntakeQueue}=await import('../src/bot/media-intake-sync.mjs'),sync=()=>syncIntakeQueue(f.app,{getEntry:id=>queue.get(id),blocked:false,backup:null});sync();assert.match(f.app.card(id).text,/На согласовании/);
 for(const e of queue.values()){e.status='approved';e.approval={at:'2026-11-07T10:00:00Z',card:{messageId:500},cardHash:e.contentHash,preview:{complete:true}};}
 sync();assert.equal(f.app.readiness(id).P9.result,'passed');
 const tg=[...queue.values()].find(e=>e.channel==='telegram'),vk=[...queue.values()].find(e=>e.channel==='vk');tg.status='published';tg.result={id:'synthetic-post',link:'https://t.me/synthetic/1'};vk.status='handed';sync();
 assert.equal(f.app.show(id).workflowClosed,false);assert.equal(f.app.readiness(id).targets.telegram.P12.result,'passed');assert.notEqual(f.app.readiness(id).targets.vk.P12.result,'passed');assert.match(f.app.card(id).text,/ожидает ручной выкладки/);
 vk.status='failed';sync();assert.match(f.app.card(id).text,/технический владелец/);
 vk.status='published';vk.result={id:'synthetic-vk',link:'https://vk.com/wall-1_1'};sync();assert.equal(f.app.show(id).workflowClosed,true);assert.equal(f.app.readiness(id).P12.result,'passed');assert.equal(f.app.readiness(id).P14.result,'blocked');assert.match(f.app.card(id).text,/Итог/);
 assert.equal(f.app.prepare(id,f.app.show(id).revision,'11').ok,false);assert.equal(f.app.ingest(photo(99,'another-material')).accepted,true);
});
test('release повторяется после потери квитанции и не снимает нового владельца',async()=>{
 const f=fixture(),id=await ready(f),j=f.app.jobs()[0],old=f.app.claim(j.id,'S1');assert.equal(f.app.release(j.id,'S1',old.token).ok,true);const next=f.app.claim(j.id,'S2');assert.equal(next.ok,true);const retry=f.app.release(j.id,'S1',old.token);assert.equal(retry.duplicate,true);assert.equal(f.app.jobs()[0].claim.owner,'S2');
});
test('контекст только владельцу: актуальный ответ доступен без новой передачи и без token/author',async()=>{
 const f=fixture(),id=await ready(f),j=f.app.jobs()[0],lease=f.app.claim(j.id,'S1');f.app.question(j.id,'S1',lease.token,{text:'Источник цифры?',allowOmit:true});
 await f.app.handleUpdate({update_id:102,message:{message_id:102,from:{id:11},chat:{id:-100123},message_thread_id:9,text:'В документе клиента',reply_to_message:{message_id:f.app.show(id).card.messageId}}});
 const c=f.app.context(j.id,'S1',lease.token);assert.equal(c.ok,true);assert.equal(c.revision,j.revision);assert.equal(c.mode,'submitted');assert.equal(c.questions[0].answer,'В документе клиента');assert.equal(c.job.claim.token,undefined);assert.equal(c.author,undefined);assert.equal(f.app.context(j.id,'S2',lease.token).ok,false);
});
test('бюджет после аннотации проверяется атомарно: отказ не меняет facts/hash/вопросы',async()=>{
 const f=fixture({config:{...config,limits:{...config.limits,maxJobInput:3000}}}),id=await ready(f),j=f.app.jobs()[0],lease=f.app.claim(j.id,'S1');
 const before=f.app.show(id),inputHash=f.app.jobs()[0].inputHash;
 const response=f.app.facts(id,before.revision,j.id,'S1',lease.token,{sources:[{id:'large-document',kind:'client-document',locator:'документ клиента: synthetic',text:'x'.repeat(5000)}],facts:[]});assert.equal(response.reason,'input_budget');assert.equal(f.app.jobs()[0].inputHash,inputHash);assert.deepEqual(f.app.show(id),before);
});
test('предвыпускной gate не захватывает старый intake-префикс, свой missing state удерживает',async()=>{
 const {publicationBlockers}=await import('../src/bot/media-intake-runtime.mjs');
 assert.deepEqual(publicationBlockers({material:'intake:foo',name:'legacy'}),[]);
 assert.deepEqual(publicationBlockers({material:'intake:foo',name:'mi-'+'b'.repeat(16)+'-1'}),[]);
 assert.deepEqual(publicationBlockers({material:'blog:article',name:'mi-'+'b'.repeat(16)+'-1'}),[]);
 assert.equal(publicationBlockers({material:'intake:'+'b'.repeat(16),name:'mi-'+'b'.repeat(16)+'-1'}).length,1);
});
