// Служебные материалы рабочей группы: закрытый приём, одна карточка и задания редактору.
// Бот не пишет публикации и не одобряет их: claim/result заканчиваются подготовкой.
// Вход фиксируется до HTTP ACK. Транспорт и импорт внедряются явно для реальной проверки.
import {createHash,randomUUID} from 'node:crypto';
import {intakeStore,intakeLock} from './media-intake-store.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safe=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const clone=x=>structuredClone(x);
const uid=()=>randomUUID().replace(/-/g,'').slice(0,16);
const numeric=x=>/^\d+$/.test(String(x??''));
const ERRORS=new Set(['TOO_LARGE','QUOTA','UNSUPPORTED','DOWNLOAD_UNAVAILABLE','INVALID_MEDIA','NETWORK','IMPORT_UNAVAILABLE']);
const fileOf=m=>{const f=m.document||m.video||m.photo?.at(-1);if(!f)return null;return {fileId:f.file_id,fileUniqueId:f.file_unique_id,size:f.file_size,name:f.file_name||(m.video?'video.mp4':'photo.jpg'),mime:f.mime_type||(m.photo?'image/jpeg':''),kind:m.video?'video':m.photo?'photo':'document'};};
const block=(reason,scope,transition,role,action,condition)=>({reason_code:reason,scope,blocked_transition:transition,owner_role:role,next_action:action,resume_condition:condition});

export function createIntake({dir,config={},clock=Date.now,importFile,telegram,verifyResult}={}){
 if(!dir)throw Error('нужен закрытый каталог приёма');
 const store=intakeStore(dir);const now=()=>new Date(clock()).toISOString();
 const cfg=()=>store.read().config||(typeof config==='function'?config():config);
 const allowed=(c,id)=>numeric(id)&&[...(c.authors||[]),...(c.coordinators||[])].map(String).includes(String(id));
 const actorCan=(c,r,id)=>allowed(c,id)&&(String(id)===r.author||(c.coordinators||[]).map(String).includes(String(id)));
 const scope=(c,m)=>String(m.chat?.id)===String(c.groupId)&&Number(m.message_thread_id||0)===Number(c.topicId||0);
 const receipt=(type,r,result,artifact)=>({evidence_id:uid(),type,subject_id:r.id,input_revision:r.revision,result,checked_at:now(),checked_by:'intake-code',artifact_ref:artifact});
 function change(r,kind){r.revision++;r[kind+'_revision']=(r[kind+'_revision']||0)+1;r.updatedAt=now();r.card.dirty=true;r.confirmedRevision=null;if(r.mode==='submitted'){r.changedAfterTransfer=true;r.mode='draft';}}
 function recordSource(m){return {messageId:m.message_id,caption:String(m.caption||'').slice(0,cfg().limits?.maxText||4000),link:m.chat?.username?`https://t.me/${m.chat.username}/${m.message_id}`:`https://t.me/c/${String(m.chat?.id).replace(/^-100/,'')}/${m.message_id}`};}
 function ingest(update){
  const c=cfg();if(!c.enabled)return{accepted:false};
  const cb=update.callback_query,m=update.message||update.edited_message;
  if(cb){if(!String(cb.data||'').startsWith('mi:')||!scope(c,cb.message||{})||!numeric(cb.from?.id))return{accepted:false};
   return store.tx(s=>{const key='cb:'+cb.id;if(s.events[key])return{accepted:true,duplicate:true};s.events[key]={kind:'callback',id:cb.id,actor:String(cb.from.id),data:String(cb.data).slice(0,64),messageId:cb.message.message_id,at:now(),status:'pending'};return{accepted:true};});}
  if(!m||!scope(c,m)||m.sender_chat||!allowed(c,m.from?.id)||!Number.isSafeInteger(update.update_id))return{accepted:false};
  const file=fileOf(m),reply=m.reply_to_message?.message_id,text=String(m.text||m.caption||'').slice(0,c.limits?.maxText||4000);
  if(!file&&!reply)return{accepted:false};
  if(file&&(!file.fileId||!file.fileUniqueId))return{accepted:false};
  return store.tx(s=>{const key='up:'+update.update_id;if(s.events[key])return{accepted:true,duplicate:true};
   const limit=c.limits?.maxPending||20;
   if(Object.values(s.events).filter(e=>e.status==='pending').length>=limit||(file&&!Object.values(s.materials).some(r=>r.album===String(m.media_group_id||'')||r.sources.some(x=>x.messageId===reply))&&Object.values(s.materials).filter(r=>!['archive','cancelled'].includes(r.mode)).length>=limit)){s.rejected={reason:'pending_limit',at:now(),count:(s.rejected?.count||0)+1};return{accepted:false,blocked:true,reason:'pending_limit'};}
   const observation={at:now(),kind:file?'media':'reply',count:file?1:0};s.observations.push(observation);if(s.observations.length>100)s.observations.shift();
   s.events[key]={kind:update.edited_message?'edited':'message',updateId:update.update_id,messageId:m.message_id,author:String(m.from.id),album:m.media_group_id?String(m.media_group_id):null,file,text,reply,source:recordSource(m),at:now(),status:'pending'};return{accepted:true,event:key};});
 }
 function stage(result,r,stage,blocks=[],artifact='state'){
  const type={P1:'event',P2:'brief-confirmation',P3:'file',P4:'brief-confirmation',P5:'claim',P6:'editor-result'}[stage];
  const evidence=type?r.evidence.filter(e=>e.type===type&&e.result==='passed'):[];
  return{result:blocks.length?'blocked':result,blockers:blocks,evidence};
 }
 function readiness(id){const s=store.read(),r=s.materials[id];if(!r)throw Error('комплект не найден');const c=cfg(),scopeId='material:'+id;
  const failedFiles=r.files.filter(f=>!f.excluded&&f.status!=='verified');
  const b3=failedFiles.map(f=>block('file_'+f.status,scopeId,'P3','S0','Сохранить исходник или явно исключить файл','verified or explicitly excluded'));
  if(!r.files.some(f=>!f.excluded))b3.push(block('no_files',scopeId,'P3','author','Добавить исходник','verified file exists'));
  const b4=[...b3];if(!r.goal)b4.push(block('goal_missing',scopeId,'P4','author','Указать цель или предложить подачу','goal set'));
  if(r.textBlocked)b4.push(block('text_limit',scopeId,'P4','author','Сократить описание','replacement description accepted'));
  if(!r.brief.trim())b4.push(block('brief_missing',scopeId,'P4','author','Ответить на карточку: что важно показать','brief supplied'));
  if(!r.targets.length||r.targets.some(t=>!t.account_ref||!t.format||!t.delivery_mode||t.readiness!=='passed'||!t.verified_at))b4.push(block('target_not_ready',scopeId,'P4','S0','Подтвердить путь выбранных площадок','target evidence passed'));
  if(r.rights.status!=='confirmed'||r.rights.manifestRevision!==r.manifest_revision)b4.push(block('rights_unknown',scopeId,'P4','author','Подтвердить права на текущий состав','rights confirmed for manifest'));
  if((!c.coordinators?.length&&c.coordinatorMode!=='operator-admin')||!c.approvers?.length)b4.push(block('roles_unset',scopeId,'P4','operator','Настроить роли','coordinator and approver configured'));
  if(!['A','B'].includes(c.handoffMode))b4.push(block('handoff_unset',scopeId,'P4','S0','Зафиксировать путь передачи','A or B verified'));
  if(!c.limits||['maxJobInput','maxJobOutput','maxCalls'].some(k=>!Number.isSafeInteger(c.limits[k])||c.limits[k]<=0))b4.push(block('budget_unset',scopeId,'P4','operator','Настроить лимиты','positive limits configured'));
  if(r.questions.some(q=>q.blocking&&q.status!=='resolved'))b4.push(block('question_open',scopeId,'P4','author','Ответить на вопрос','blocking questions resolved'));
  const j=Object.values(s.jobs).find(j=>j.materialId===id&&j.revision===r.revision&&j.status!=='superseded');
  const b5=j?.claim?[]:[block('not_claimed',scopeId,'P5','editor','Забрать задание','current job claimed')];
  return{P0:stage('blocked',r,'P0',[block('pilot_evidence_pending',scopeId,'P0','S0','Подтвердить реальный контур пилота','deployment and pilot evidence')]),P1:stage('passed',r,'P1'),P2:stage('passed',r,'P2',r.confirmedRevision===r.revision?[]:[block('manifest_unconfirmed',scopeId,'P2','author','Проверить состав','Подготовить так for current revision')]),
   P3:stage('passed',r,'P3',b3),P4:stage('passed',r,'P4',[...b4,...(r.confirmedRevision===r.revision?[]:[block('brief_unconfirmed',scopeId,'P4','author','Подготовить так','current revision confirmed')])]),
   P5:stage('passed',r,'P5',b5),P6:stage('passed',r,'P6',j?.status==='completed'&&j.artifactsVerified?[]:[block('result_missing',scopeId,'P6','editor','Подготовить проверяемые варианты','validated result exists')]),
   P7:stage('blocked',r,'P7',[block('queue_checks_pending',scopeId,'P7','editor','Проверить конечные варианты штатными проверками','versioned check evidence')]),
   P8:stage('blocked',r,'P8',[block('preview_pending',scopeId,'P8','editor','Передать конечные варианты на согласование','complete preview receipt')]),
   P9:stage('blocked',r,'P9',[block('not_publication_approval',scopeId,'P9','approver','Штатно согласовать конечный вариант','queue approval for actual payload')]),
   ...Object.fromEntries(['P10','P11','P12','P13'].map(p=>[p,stage('blocked',r,p,[block('queue_evidence_pending',scopeId,p,'queue','Продолжить штатную очередь после подготовки','actual queue receipt')])])),
   P14:stage('blocked',r,'P14',[block('backup_unverified',scopeId,'P14','S0','Подтвердить независимую копию и восстановление','backup and restore receipts')])};
 }
 function events(){store.tx(s=>{for(const e of Object.values(s.events)){if(e.status!=='pending'||e.kind==='callback')continue;
   let r=Object.values(s.materials).find(r=>e.reply&&(r.card.messageId===e.reply||r.sources.some(x=>x.messageId===e.reply)));
   if(!r&&e.file)r=Object.values(s.materials).find(r=>r.album&&r.album===e.album);
   if(!r&&e.file&&e.kind!=='edited'){
    if(Object.values(s.materials).filter(r=>!['archive','cancelled'].includes(r.mode)).length>=(cfg().limits?.maxPending||20)){e.status='blocked';e.reason='pending_limit';continue;}
    r={id:uid(),author:e.author,groupId:String(cfg().groupId),topicId:cfg().topicId||0,album:e.album,revision:1,manifest_revision:1,brief_revision:1,timing_revision:1,confirmedRevision:null,files:[],sources:[],brief:'',goal:'show-object',editing_mode:'adapt',targets:clone(cfg().targets||[]),timing:{mode:'after_approval',source:'project'},rights:{status:'needs_clarification'},questions:[],mode:'draft',createdAt:now(),updatedAt:now(),card:{status:'new',messageId:null,dirty:true},evidence:[]};s.materials[r.id]=r;
   }
   if(!r||!actorCan(cfg(),r,e.author)){e.status='ignored';continue;}
   if(['archive','cancelled'].includes(r.mode)){e.status='ignored';continue;}
   const old=r.sources.find(x=>x.messageId===e.messageId);
   if(r.sources.filter(x=>x!==old).reduce((n,x)=>n+x.caption.length,0)+e.text.length>(cfg().limits?.maxText||4000)){e.status='blocked';e.reason='text_limit';r.textBlocked=true;r.card.dirty=true;continue;}
   if(e.kind==='edited'&&!old){e.status='ignored';continue;}
   if(old){if(old.caption!==e.text){old.caption=e.text;r.facts=(r.facts||[]).filter(f=>f.sourceId!=='message-'+e.messageId);change(r,'brief');r.brief=r.sources.map(x=>x.caption).filter(Boolean).join('\n');}}
   else{r.sources.push({...e.source,caption:e.text});if(e.text){r.brief=r.sources.map(x=>x.caption).filter(Boolean).join('\n');change(r,'brief');
     const open=r.questions.filter(q=>q.status==='open');if(open.length===1){open[0].answer=e.text;open[0].answeredBy=e.author;open[0].status='answered';}
    }}
   if(e.kind==='edited'&&e.file&&!r.files.some(f=>f.fileUniqueId===e.file.fileUniqueId&&f.messages.includes(e.messageId))){
    // Замена файла в исходном сообщении не удаляет сохранённый оригинал.
    for(const oldFile of r.files.filter(f=>f.messages.includes(e.messageId)))oldFile.excluded={reason:'replaced-in-source',by:e.author,at:now()};
   }
   if(e.file){const existing=r.files.find(f=>f.fileUniqueId===e.file.fileUniqueId);
    if(existing){if(!existing.messages.includes(e.messageId))existing.messages.push(e.messageId);}
    else if(r.files.length<(cfg().limits?.maxFiles||10)){r.files.push({...e.file,messageId:e.messageId,messages:[e.messageId],status:'pending',excluded:false});r.files.sort((a,b)=>a.messageId-b.messageId);change(r,'manifest');r.rights={status:'needs_clarification'};}
    else{e.status='blocked';e.reason='file_limit';r.limitBlocked=true;change(r,'manifest');continue;}
   }
   r.lastIncomingAt=clock();r.evidence.push(receipt('event',r,'passed','update:'+e.updateId));e.status='done';e.materialId=r.id;
  }});}
 function edit(id,revision,actor,patch){return store.tx(s=>{const r=s.materials[id];if(!r||!actorCan(cfg(),r,actor))throw Error('нет права менять комплект');if(r.revision!==revision)throw Error('устаревшая версия');if(r.mode==='cancelled')throw Error('задание отменено');
   const keys=Object.keys(patch);if(keys.some(k=>!['goal','brief','targets','excludeFile','editing_mode','timing','rights','mode','resolveQuestion'].includes(k)))throw Error('неизвестная правка');
   for(const key of keys){const value=patch[key];
    if(key==='excludeFile'){const f=r.files.find(f=>f.fileUniqueId===value);if(!f)throw Error('файл не найден');f.excluded={by:String(actor),at:now()};change(r,'manifest');r.rights={status:'needs_clarification'};}
    else if(key==='rights'){if(value!==true)throw Error('нужно явное подтверждение');r.rights={status:'confirmed',manifestRevision:r.manifest_revision,by:String(actor),at:now()};change(r,'brief');}
    else if(key==='targets'){if(!Array.isArray(value)||!value.length||value.some(v=>!cfg().targets?.some(t=>hash(t)===hash(v))))throw Error('площадка не настроена');r.targets=clone(value);change(r,'brief');}
    else if(key==='mode'){if(!['draft','discussion','archive','cancelled'].includes(value))throw Error('неизвестный режим');r.mode=value;change(r,'brief');}
    else if(key==='goal'||key==='brief'){if(typeof value!=='string'||value.length>(cfg().limits?.maxText||4000))throw Error('неверный текст');r[key]=value;if(key==='brief')r.textBlocked=false;change(r,'brief');}
    else if(key==='editing_mode'){if(!['adapt','preserve_wording'].includes(value))throw Error('режим редактирования');r[key]=value;change(r,'brief');}
    else if(key==='timing'){if(!['after_approval','choose_later','at','not_before'].includes(value?.mode)||(['at','not_before'].includes(value.mode)&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.at||'')||!Number.isFinite(Date.parse(value.at))||new Date(value.at).toISOString().replace('.000Z','Z')!==value.at.replace('.000Z','Z'))))throw Error('нужно однозначное время UTC');r.timing=clone(value);change(r,'timing');}
    else if(key==='resolveQuestion'){const q=r.questions.find(q=>q.id===value?.id);if(!q||q.status==='resolved')throw Error('вопрос не найден');q.status='resolved';q.answer=String(value.answer||'').slice(0,1000);change(r,'brief');}
   }return r;
  });}
 function prepare(id,rev,actor){
  const r=store.read().materials[id];if(!r||!actorCan(cfg(),r,actor)||r.revision!==rev)return{ok:false,reason:'stale_or_forbidden'};
  const repeated=Object.values(store.read().jobs).find(j=>j.materialId===id&&j.revision===rev);if(r.mode==='submitted'&&repeated)return{ok:true,duplicate:true,jobId:repeated.id};
  if(r.mode!=='draft')return{ok:false,reason:'mode'};
  const current=readiness(id),blocks=current.P4.blockers.filter(b=>b.reason_code!=='brief_unconfirmed');if(r.limitBlocked)blocks.push(block('file_limit','material:'+id,'P4','author','Разделить комплект','all files accounted'));
  if(blocks.length)return{ok:false,blockers:blocks};
  return store.tx(s=>{const m=s.materials[id];if(m.revision!==rev)return{ok:false};
   const existing=Object.values(s.jobs).find(j=>j.materialId===id&&j.revision===rev);if(existing)return{ok:true,duplicate:true,jobId:existing.id};
   const input={materialId:id,revision:rev,manifestRevision:m.manifest_revision,briefRevision:m.brief_revision,brief:m.brief,goal:m.goal,targets:m.targets,files:m.files.filter(f=>!f.excluded).map(f=>({mediaId:f.mediaId,sha256:f.sha256,mime:f.mime,bytes:f.bytes})),rights:{status:m.rights.status,manifestRevision:m.rights.manifestRevision},timing:m.timing,editing_mode:m.editing_mode,policyVersion:cfg().policyVersion,
    sources:m.sources.map(x=>({id:'message-'+x.messageId,kind:'author_statement',locator:x.link,text:x.caption,receivedAt:m.createdAt})).concat(m.factSources||[]),facts:(m.facts||[]).map(({claim,source})=>({claim,source})),questions:m.questions.map(({id,text,status,answer,resolution})=>({id,text,status,answer,resolution}))};
   if(JSON.stringify(input).length>cfg().limits.maxJobInput)return{ok:false,reason:'input_budget'};
   m.confirmedRevision=rev;m.mode='submitted';m.card.dirty=true;
   const j={id:uid(),materialId:id,revision:rev,inputHash:hash(input),input,targets:clone(m.targets),status:'queued',createdAt:now(),claim:null,result:null};s.jobs[j.id]=j;m.evidence.push(receipt('brief-confirmation',m,'passed',j.id));return{ok:true,jobId:j.id};
  });
 }
 async function callbacks(){for(const event of Object.values(store.read().events).filter(e=>e.kind==='callback'&&e.status==='pending')){
  const match=/^mi:([a-f0-9]{16}):(\d+):([a-z0-9_-]+)$/.exec(event.data);let answer='Откройте текущую карточку';
  if(match){const [,id,ver,action]=match,r=store.read().materials[id];if(r&&r.card.messageId===event.messageId&&r.revision===Number(ver)&&actorCan(cfg(),r,event.actor)){
   try{
    if(action==='prepare'){const res=prepare(id,Number(ver),event.actor);answer=res.ok?'Задание передано. Это не одобрение публикации.':res.blockers?.[0]?.next_action||'Передача пока невозможна';}
    else if(action==='rights'){edit(id,Number(ver),event.actor,{rights:true});answer='Подтверждение сохранено';}
    else if(['archive','cancel','discuss'].includes(action)){edit(id,Number(ver),event.actor,{mode:{archive:'archive',cancel:'cancelled',discuss:'discussion'}[action]});answer='Решение сохранено';}
    else if(action==='object'||action==='product'||action==='other'){edit(id,Number(ver),event.actor,{goal:action});answer='Цель изменена';}
    else if(action.startsWith('target-')){const channel=action.slice(7),t=cfg().targets.find(x=>x.channel===channel);if(t){const selected=r.targets.some(x=>x.channel===channel);edit(id,Number(ver),event.actor,{targets:selected?r.targets.filter(x=>x.channel!==channel):[...r.targets,t]});answer='Площадки изменены';}}
    else if(action.startsWith('omit-')){const qid=action.slice(5);store.tx(s=>{const m=s.materials[id],q=m.questions.find(q=>q.id===qid&&q.allowOmit);if(!q||q.status==='resolved')throw Error();q.status='resolved';q.resolution='omit';q.by=event.actor;change(m,'brief');});answer='Спорное утверждение исключается из подготовки';}
    else if(action==='reopen'&&['archive','discussion'].includes(r.mode)){edit(id,Number(ver),event.actor,{mode:'draft'});answer='Возвращено в подготовку задания; публикация не одобрена';}
    else if(action==='edit'){store.tx(s=>{s.materials[id].editRequested=true;s.materials[id].card.dirty=true;});answer='Ответьте на карточку: цель или описание. Площадки меняются кнопками.';}
   }catch{answer='Действие не применено: откройте текущую карточку';}
  }}
  store.tx(s=>{s.events['cb:'+event.id].status='done';});if(telegram)await telegram('answerCallbackQuery',{callback_query_id:event.id,text:answer});
 }}
 function card(id){const r=store.read().materials[id];if(!r)throw Error('комплект не найден');const active=r.files.filter(f=>!f.excluded),verified=active.filter(f=>f.status==='verified');
  const state={draft:'Собираем материал',submitted:Object.values(store.read().jobs).some(j=>j.materialId===id&&j.revision===r.revision&&j.claim)?'В подготовке':'Ожидает подготовки',discussion:'Только обсуждение',archive:'В архиве; резервирование не подтверждено',cancelled:'Отменено'}[r.mode];
  const titles={telegram:'Telegram',vk:'ВКонтакте',instagram:'Instagram',threads:'Threads',dzen:'Дзен',youtube:'YouTube',rutube:'Rutube'},formats={album:'альбом',photopost:'пост с фото',carousel:'карусель',post:'пост',video:'видео'},goals={'show-object':'показать объект',object:'показать объект',product:'объяснить продукт',other:'другая цель'};
  const lines=[`<b>${safe(state)}</b>`,`Сохранено ${verified.length} из ${active.length} файлов.`,r.changedAfterTransfer?'Состав изменён после передачи. Нужна новая версия задания.':'',`Предложение: ${safe(goals[r.goal]||r.goal||'предложить подачу')}.`,
   `Подготовим: ${r.targets.map(t=>safe(`${titles[t.channel]||t.channel} — ${formats[t.format]||t.format} (${t.delivery_mode==='manual'?'ручная выкладка':'автоматическая публикация'})`)).join('; ')||'не выбрано'}.`,r.brief?`Описание: ${safe(r.brief.slice(0,1400))}`:'Нужен ответ: опишите, что важно показать. Ответьте на эту карточку.',
   r.rights.status==='confirmed'?'Права на текущий состав подтверждены.':'Нужен ответ: подтвердите право публично использовать текущие файлы. Людей/музыку при необходимости проверит редактор; дети в кадре запрещены.',
   r.timing.mode==='choose_later'?'Выпуск отложен до выбора времени; «Одобрить» не отменяет это условие.':r.timing.at?`Выпуск ${r.timing.mode==='not_before'?'не раньше':'точно'} ${safe(new Date(r.timing.at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}))} (Москва), после отдельного «Одобрить».`:'Выпуск: после отдельного «Одобрить» готового варианта каждой площадки.',
   r.limitBlocked?'Есть непринятые файлы: лимит комплекта. Нужен координатор, чтобы явно разделить комплект; передача остановлена.':'',
   r.textBlocked?'Описание превышает предел пилота. Нужен сокращённый ответ или разделение задания.':'',
   r.editRequested?'Ответьте на эту карточку новым описанием.':'',...r.questions.filter(q=>q.status!=='resolved').map(q=>`Нужен ваш ответ: ${safe(q.text)}${q.status==='answered'?' Ответ получен; редактор проверяет источник.':''}`),...r.files.filter(f=>f.status==='failed'&&!f.excluded).map(f=>`Не сохранён файл: ${safe(f.errorCode)}. Для большого видео — закрытая передача оператором в медиатеку.`)];
  const data=action=>`mi:${r.id}:${r.revision}:${action}`;
  const buttons=r.mode==='cancelled'?[]:['archive','discussion'].includes(r.mode)?[[{text:'Вернуть к заданию',callback_data:data('reopen')}]]:[[{text:'Подготовить так',callback_data:data('prepare')},{text:'Изменить задание',callback_data:data('edit')}],
   [{text:'Только обсудить',callback_data:data('discuss')},{text:'В архив',callback_data:data('archive')}],...(r.rights.status!=='confirmed'?[[{text:'Право использования подтверждаю',callback_data:data('rights')}]]:[]),
   ...r.questions.filter(q=>q.status!=='resolved'&&q.allowOmit).map(q=>[{text:'Не использовать спорное утверждение',callback_data:data('omit-'+q.id)}]),
   ...(r.editRequested?[[{text:'Показать объект',callback_data:data('object')},{text:'Объяснить продукт',callback_data:data('product')},{text:'Другое',callback_data:data('other')}],cfg().targets.map(t=>({text:(r.targets.some(x=>x.channel===t.channel)?'✓ ':'')+(titles[t.channel]||t.channel),callback_data:data('target-'+t.channel)}))]:[]),[{text:'Отменить',callback_data:data('cancel')}]];
  return{text:lines.filter(Boolean).join('\n\n').slice(0,3900),reply_markup:{inline_keyboard:buttons}};
 }
 async function flush(){
  // Один процесс импортирует/отправляет; при аварии неизвестная отправка не повторяется.
  if(!cfg().enabled)return{disabled:true};
  const unlock=intakeLock(store.dir+'/worker.lock');if(!unlock)return{busy:true};
  try{events();await callbacks();
   for(const r of Object.values(store.read().materials))for(const f of r.files){if(f.status!=='pending'||f.excluded)continue;
    let result,errorCode;
    try{if(f.size>(cfg().limits?.maxBytes||0))throw Object.assign(Error(),{code:'TOO_LARGE'});if(!importFile)throw Object.assign(Error(),{code:'IMPORT_UNAVAILABLE'});
     result=await importFile({...f,material:'intake:'+r.id,source:r.sources.find(x=>x.messageId===f.messageId)?.link||'Telegram staff',variant:f.fileUniqueId});
     if(!result?.verified||!result.readable||!result.mediaId||!/^[a-f0-9]{64}$/.test(result.sha256)||!(result.bytes>0)||result.bytes>cfg().limits.maxBytes||!['image/jpeg','image/png','image/webp','video/mp4','video/quicktime'].includes(result.mime))throw Object.assign(Error(),{code:'INVALID_MEDIA'});
    }catch(e){errorCode=ERRORS.has(e.code)?e.code:'INVALID_MEDIA';}
    store.tx(s=>{const m=s.materials[r.id],item=m.files.find(x=>x.fileUniqueId===f.fileUniqueId);Object.assign(item,errorCode?{status:'failed',errorCode}:{status:'verified',mediaId:result.mediaId,sha256:result.sha256,bytes:result.bytes,mime:result.mime});m.card.dirty=true;m.evidence.push(receipt('file',m,errorCode?'failed':'passed',errorCode||result.mediaId));});
   }
   for(const r of Object.values(store.read().materials)){if(!telegram||!r.card.dirty||['sending','unknown'].includes(r.card.status)||clock()-(r.lastIncomingAt||0)<(cfg().quietMs||0))continue;
    const content=card(r.id),first=!r.card.messageId;
    if(first)store.tx(s=>{s.materials[r.id].card.status='sending';});
    let res;try{res=await telegram(first?'sendMessage':'editMessageText',{chat_id:r.groupId,...(r.topicId?{message_thread_id:r.topicId}:{}),...(first?{reply_parameters:{message_id:r.sources[0].messageId,allow_sending_without_reply:true}}:{message_id:r.card.messageId}),parse_mode:'HTML',...content});}catch{res={ok:false,uncertain:true};}
    store.tx(s=>{const m=s.materials[r.id];if(res.ok&&(res.messageId||!first)){m.card={status:'sent',messageId:res.messageId||m.card.messageId,dirty:m.revision!==r.revision,revision:r.revision};m.evidence.push(receipt('card',m,'passed','message:'+m.card.messageId));}else{m.card.status=first?'unknown':'sent';m.card.dirty=true;}});
   }return{ok:true};
  }finally{unlock();}
 }
 function claim(id,owner,requestId){if(!['S1','S2'].includes(owner))return{ok:false,reason:'owner'};if(requestId!==undefined&&!/^[a-f0-9]{32}$/.test(requestId))return{ok:false,reason:'request_id'};
  return store.tx(s=>{const j=s.jobs[id],m=j&&s.materials[j.materialId];
   if(j?.status==='claimed'&&requestId&&j.claim.owner===owner&&j.claim.requestId===requestId)return{ok:true,duplicate:true,token:j.claim.token,job:clone(j)};
   if(!j||j.status!=='queued'||m.revision!==j.revision||Object.values(s.jobs).some(other=>other.materialId===j.materialId&&other.status==='claimed'))return{ok:false,reason:'busy_or_stale'};
   j.status='claimed';j.claim={owner,token:uid(),at:now(),...(requestId?{requestId}:{})};j.delivery={mode:cfg().handoffMode,at:now(),result:'accepted'};m.card.dirty=true;m.evidence.push(receipt('claim',m,'passed',j.id));return{ok:true,token:j.claim.token,job:clone(j)};
  });}
 function result(id,owner,token,value){return store.tx(s=>{const j=s.jobs[id],m=j&&s.materials[j.materialId];if(!j||j.claim?.owner!==owner||j.claim.token!==token)return{ok:false,reason:'claim'};
  if(m.revision!==j.revision||m.mode!=='submitted')return{ok:false,reason:'stale'};const digest=hash(value);if(j.status==='completed')return{ok:j.resultHash===digest,duplicate:j.resultHash===digest};
  if(value?.inputHash!==j.inputHash||!Array.isArray(value.variants)||JSON.stringify(value).length>cfg().limits.maxJobOutput)return{ok:false,reason:'schema'};
  const wanted=new Set(j.targets.map(t=>t.channel));if(value.variants.length!==wanted.size||new Set(value.variants.map(v=>v.channel)).size!==wanted.size)return{ok:false,reason:'targets'};
  for(const v of value.variants){if(!wanted.has(v.channel)||v.format!==j.targets.find(t=>t.channel===v.channel)?.format||typeof v.text!=='string'||!v.text.trim()||!Array.isArray(v.mediaIds)||!v.mediaIds.length||v.mediaIds.some(id=>typeof id!=='string'))return{ok:false,reason:'variant'};}
  if(!verifyResult||!verifyResult(value,j))return{ok:false,reason:'artifact_verification'};
  j.result=clone(value);j.resultHash=digest;j.artifactsVerified=true;j.status='completed';j.completedAt=now();m.card.dirty=true;m.evidence.push(receipt('editor-result',m,'passed',j.id));return{ok:true,publicationApproved:false};
 });}
 function question(id,owner,token,value){return store.tx(s=>{const j=s.jobs[id],r=j&&s.materials[j.materialId];if(!j||j.status!=='claimed'||j.claim.owner!==owner||j.claim.token!==token||j.revision!==r.revision)return{ok:false,reason:'claim'};
  if(typeof value?.text!=='string'||!value.text.trim()||value.text.length>600||r.questions.filter(q=>q.status!=='resolved').length>=1)return{ok:false,reason:'question'};
  r.questions.push({id:uid(),text:value.text,blocking:true,allowOmit:value.allowOmit===true,status:'open',ownerRole:owner,inputRevision:r.revision});change(r,'brief');return{ok:true,revision:r.revision};
 });}
 function facts(id,revision,jobId,owner,token,value){return store.tx(s=>{
  const r=s.materials[id],j=s.jobs[jobId];if(!r||!j||j.materialId!==id||j.status!=='claimed'||j.claim?.owner!==owner||j.claim.token!==token||r.revision!==revision)return{ok:false,reason:'claim_or_revision'};
  if(!Array.isArray(value?.facts)||value.facts.length>20||!Array.isArray(value.sources)||value.sources.length>20)return{ok:false,reason:'facts_schema'};
  const sources=r.sources.map(x=>({id:'message-'+x.messageId,kind:'author_statement',locator:x.link,text:x.caption}));
  for(const src of value.sources){if(!/^[a-z0-9-]{1,64}$/.test(src.id||'')||sources.some(s=>s.id===src.id)||!['client-page','client-document'].includes(src.kind)||typeof src.text!=='string'||src.text.length>6000||!src.text.trim()||typeof src.locator!=='string'||src.locator.length>300)return{ok:false,reason:'source'};
   if(src.kind==='client-page'){let url;try{url=new URL(src.locator);}catch{return{ok:false,reason:'source'};}if(url.protocol!=='https:'||url.username||url.password||url.search||!['ecopolisrf.ru','www.ecopolisrf.ru'].includes(url.hostname))return{ok:false,reason:'source'};}
   sources.push({...src,status:'reviewed-by-editor',checkedAt:now(),checkedBy:owner});
  }
  const checked=[];for(const fact of value.facts){const src=sources.find(s=>s.id===fact.sourceId);if(!src||typeof fact.claim!=='string'||!fact.claim.trim()||fact.claim.length>1000||!src.text.includes(fact.claim)||fact.confirmed!==true)return{ok:false,reason:'unverified_claim'};
   if(src.kind==='author_statement'&&(typeof fact.namedSource!=='string'||!fact.namedSource.trim()||fact.namedSource.length>80||!/^\d{4}-\d\d-\d\d$/.test(fact.sourceDate||'')||!Number.isFinite(Date.parse(fact.sourceDate))))return{ok:false,reason:'named_source_required'};
   const source=src.kind==='author_statement'?`интервью: ${fact.namedSource}, ${fact.sourceDate}; ${src.locator}`:src.locator;
   checked.push({claim:fact.claim,source,sourceId:src.id,status:src.kind==='author_statement'?'author_statement_reviewed':'confirmed_source',checkedBy:owner,checkedAt:now()});
  }
  const resolutions=value.resolutions||[];if(!Array.isArray(resolutions))return{ok:false,reason:'resolutions'};
  for(const resolution of resolutions){const q=r.questions.find(q=>q.id===resolution.questionId&&q.status!=='resolved');
   if(!q)return{ok:false,reason:'question'};
   if(resolution.type==='omit'){if(!q.allowOmit)return{ok:false,reason:'omit_not_allowed'};}
   else if(resolution.type==='source'){if(!Array.isArray(resolution.claims)||!resolution.claims.length||resolution.claims.some(claim=>!checked.some(f=>f.claim===claim&&f.sourceId===resolution.sourceId)))return{ok:false,reason:'question_source'};}
   else return{ok:false,reason:'resolution_type'};
  }
  r.facts=checked;r.factSources=sources.filter(s=>s.kind!=='author_statement');r.facts_revision=(r.facts_revision||0)+1;
  for(const resolution of resolutions){const q=r.questions.find(q=>q.id===resolution.questionId);q.status='resolved';q.resolution=resolution.type;q.sourceId=resolution.sourceId||null;q.claims=resolution.claims||[];q.checkedBy=owner;}
  // Аннотация уже принятого содержания не меняет клиентское задание/manifest.
  // Меняем только зависимости редакторского пакета; прежний результат с иным hash отвергается.
  if(j.revision===r.revision){j.input.facts=r.facts.map(({claim,source})=>({claim,source}));j.input.sources=sources;j.input.factsRevision=r.facts_revision;j.inputHash=hash(j.input);}
  r.card.dirty=true;return{ok:true,revision:r.revision,factsRevision:r.facts_revision,inputHash:j.revision===r.revision?j.inputHash:null,job:j.revision===r.revision?clone(j):null};
 });}
 function release(id,owner,token){return store.tx(s=>{const j=s.jobs[id];
  if(j?.previousClaim?.owner===owner&&j.previousClaim.token===token)return{ok:true,duplicate:true,status:j.status};
  if(!j||j.claim?.owner!==owner||j.claim.token!==token)return{ok:false,reason:'claim'};if(j.status!=='claimed')return{ok:false,reason:'status'};j.status=s.materials[j.materialId].revision===j.revision?'queued':'superseded';j.previousClaim=j.claim;j.claim=null;return{ok:true,status:j.status};});}
 function retry(id,revision,actor){return store.tx(s=>{const r=s.materials[id];if(!r||r.revision!==revision||!actorCan(cfg(),r,actor))throw Error('нет права или версия устарела');for(const f of r.files)if(f.status==='failed')f.status='pending';return{ok:true};});}
 return{ingest,flush,handleUpdate:async u=>{const r=ingest(u);await flush();return r;},list:()=>Object.values(store.read().materials).map(r=>({id:r.id,revision:r.revision,mode:r.mode,files:r.files.length})),show:id=>clone(store.read().materials[id]),
  readiness,card,edit,prepare,jobs:()=>Object.values(store.read().jobs).map(clone),claim,result,question,facts,release,retry,store};
}
