// Служебные материалы рабочей группы: закрытый приём, одна карточка и задания редактору.
// Бот не пишет публикации и не одобряет их: claim/result заканчиваются подготовкой.
// Вход фиксируется до HTTP ACK. Транспорт и импорт внедряются явно для реальной проверки.
import {createHash,randomUUID} from 'node:crypto';
import {intakeStore,intakeLock} from './media-intake-store.mjs';
import {targetSpec,targetKey,targetToken,targetEntryName,targetFiles,targetProblems,chooseTargets,recipientFor,channelTitle} from './media-intake-targets.mjs';
import {evaluatePilot} from './media-intake-pilot.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safe=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const clone=x=>structuredClone(x);
const uid=()=>randomUUID().replace(/-/g,'').slice(0,16);
const numeric=x=>/^\d+$/.test(String(x??''));
const ERRORS=new Set(['TOO_LARGE','QUOTA','UNSUPPORTED','DOWNLOAD_UNAVAILABLE','INVALID_MEDIA','NETWORK','IMPORT_UNAVAILABLE']);
const fileOf=m=>{const f=m.document||m.video||m.photo?.at(-1);if(!f)return null;return {fileId:f.file_id,fileUniqueId:f.file_unique_id,size:f.file_size,name:f.file_name||(m.video?'video.mp4':'photo.jpg'),mime:f.mime_type||(m.photo?'image/jpeg':''),kind:m.video?'video':m.photo?'photo':'document'};};
const block=(reason,scope,transition,role,action,condition)=>({reason_code:reason,scope,blocked_transition:transition,owner_role:role,next_action:action,resume_condition:condition});
export function parseMaterialMoment(text){const value=String(text||'').trim();let date;
 if(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?Z$/.test(value)){date=new Date(value);if(!Number.isFinite(date.getTime()))return null;const m=/^(.*T\d\d:\d\d)(?::(\d\d)(\.\d{3})?)?Z$/.exec(value),expected=m[1]+':'+(m[2]||'00')+(m[3]||'.000')+'Z';if(date.toISOString()!==expected)return null;}
 else{const m=/^(\d\d)\.(\d\d)\.(\d{4})\s+(\d\d):(\d\d)$/.exec(value);if(!m)return null;const local=`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00`,ms=Date.parse(local+'+03:00');if(!Number.isFinite(ms)||new Date(ms+3*3600000).toISOString().slice(0,19)!==local)return null;date=new Date(ms);}
 return Number.isFinite(date.getTime())?date.toISOString():null;
}

export function createIntake({dir,config={},clock=Date.now,importFile,telegram,verifyResult,getQueueEntry,pilotEvidence}={}){
 if(!dir)throw Error('нужен закрытый каталог приёма');
 const store=intakeStore(dir);const now=()=>new Date(clock()).toISOString();
 const cfg=()=>store.read().config||(typeof config==='function'?config():config);
 const catalog=()=>cfg().targetCatalog||cfg().targets||[];
 const selectedFiles=(r,t)=>{const explicit=r.targetAssets?.[targetKey(t)];return explicit?r.files.filter(f=>explicit.includes(f.fileUniqueId)):r.files;};
 const refreshTargets=r=>{if(r.targetsExplicit)return;const next=chooseTargets(cfg().targets||[],r.files),extras=(cfg().targets||[]).filter(t=>r.targetAssets?.[targetKey(t)]&&!targetProblems(t,selectedFiles(r,t)).length);for(const t of extras)if(!next.some(x=>targetKey(x)===targetKey(t)))next.push(clone(t));if(hash(next)!==hash(r.targets)){r.targets=next;change(r,'brief');}};
 const allowed=(c,id)=>numeric(id)&&[...(c.authors||[]),...(c.coordinators||[])].map(String).includes(String(id));
 const actorCan=(c,r,id)=>allowed(c,id)&&(String(id)===r.author||(c.coordinators||[]).map(String).includes(String(id)));
 const scope=(c,m)=>String(m.chat?.id)===String(c.groupId)&&Number(m.message_thread_id||0)===Number(c.topicId||0);
 const receipt=(type,r,result,artifact)=>({evidence_id:uid(),type,subject_id:r.id,input_revision:r.revision,result,checked_at:now(),checked_by:'intake-code',artifact_ref:artifact});
 const sameContent=(r,j)=>r&&j&&r.mode==='submitted'&&(j.manifestRevision??j.input?.manifestRevision)===r.manifest_revision&&(j.input?.contentEpoch||0)===(r.content_epoch||0);
 const currentTarget=(r,j,key)=>Boolean(sameContent(r,j)&&(r.targetJobs?r.targetJobs[key]===j.id:r.revision===j.revision)&&j.targets.some(t=>targetKey(t)===key));
 const currentJob=(r,j)=>Boolean(sameContent(r,j)&&(r.revision===j.revision||j.scope==='target-rework'&&j.targets.length&&j.targets.every(t=>currentTarget(r,j,targetKey(t)))));
 function change(r,kind){
  if(r.queueSummary){r.previousQueueSummaries||=[];r.previousQueueSummaries.push({revision:r.revision,summary:r.queueSummary});delete r.queueSummary;r.workflowClosed=false;}
  r.revision++;r.content_epoch=(r.content_epoch||0)+1;r[kind+'_revision']=(r[kind+'_revision']||0)+1;r.updatedAt=now();r.card.dirty=true;r.confirmedRevision=null;if(r.mode==='submitted'){r.changedAfterTransfer=true;r.mode='draft';}
 }
 function recordSource(m){return {messageId:m.message_id,caption:String(m.caption||'').slice(0,cfg().limits?.maxText||4000),link:m.chat?.username?`https://t.me/${m.chat.username}/${m.message_id}`:`https://t.me/c/${String(m.chat?.id).replace(/^-100/,'')}/${m.message_id}`};}
 function setTiming(s,r,value){
  if(!['after_approval','choose_later','at','not_before'].includes(value?.mode)||(['at','not_before'].includes(value.mode)&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.at||'')||parseMaterialMoment(value.at)!==new Date(value.at).toISOString())))throw Error('нужно однозначное время UTC');
  const jobs=Object.values(s.jobs).filter(j=>j.materialId===r.id&&currentJob(r,j));
  if(jobs.some(j=>Object.keys(j.queueResults||{}).length))throw Error('срок после передачи в очередь меняет штатная команда queue move, согласие на текст сохраняется');
  r.timing=clone(value);r.timing_revision++;r.card.dirty=true;for(const job of jobs){job.input.timing=clone(value);job.inputHash=hash(job.input);if(job.result){job.result.inputHash=job.inputHash;job.resultHash=hash(job.result);}}
 }
 function ingest(update){
  const c=cfg();if(!c.enabled)return{accepted:false};
  const cb=update.callback_query,m=update.message||update.edited_message;
  if(cb){if(!String(cb.data||'').startsWith('mi:')||!scope(c,cb.message||{})||!numeric(cb.from?.id))return{accepted:false};
   return store.tx(s=>{const key='cb:'+cb.id;if(s.events[key])return{accepted:true,duplicate:true};s.events[key]={kind:'callback',id:cb.id,actor:String(cb.from.id),data:String(cb.data).slice(0,64),messageId:cb.message.message_id,at:now(),status:'pending'};return{accepted:true};});}
  if(!m||!scope(c,m)||m.sender_chat||!allowed(c,m.from?.id)||!Number.isSafeInteger(update.update_id))return{accepted:false};
  // Telegram может пометить обычное сообщение форума как reply на корень темы.
  // Это новая подача, а не ответ на карточку или на чужое сообщение.
  const rawReply=m.reply_to_message?.message_id,reply=c.topicId>0&&rawReply===c.topicId?null:rawReply;
  const file=fileOf(m),text=String(m.text||m.caption||'').slice(0,c.limits?.maxText||4000);
  if(!file&&(!text.trim()||text.trim().startsWith('/')))return{accepted:false};
  if(file&&(!file.fileId||!file.fileUniqueId))return{accepted:false};
  return store.tx(s=>{const key='up:'+update.update_id;if(s.events[key])return{accepted:true,duplicate:true};
   const limit=c.limits?.maxPending||20;
   if(Object.values(s.events).filter(e=>e.status==='pending').length>=limit||((file||text)&&!Object.values(s.materials).some(r=>r.album===String(m.media_group_id||'')||r.sources.some(x=>x.messageId===reply)||r.card.messageId===reply)&&Object.values(s.materials).filter(r=>!r.workflowClosed&&!['archive','cancelled','closed'].includes(r.mode)).length>=limit)){s.rejected={reason:'pending_limit',at:now(),count:(s.rejected?.count||0)+1};return{accepted:false,blocked:true,reason:'pending_limit'};}
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
  const textOnly=!r.files.some(f=>!f.excluded)&&Boolean(r.brief.trim());
  if(!r.files.some(f=>!f.excluded)&&!textOnly)b3.push(block('no_files',scopeId,'P3','author','Добавить исходник','verified file exists'));
  const b4=[...b3];if(!r.goal)b4.push(block('goal_missing',scopeId,'P4','author','Указать цель или предложить подачу','goal set'));
  for(const t of r.targets)for(const problem of targetProblems(t,selectedFiles(r,t)))b4.push(block(problem.code,'target:'+targetKey(t),'P4',problem.code==='target_not_ready'?'S0':'author',problem.reason,'compatible verified target and explicit assets'));
  if(r.files.some(f=>!f.excluded&&f.mime?.startsWith('video/'))&&!r.targets.some(t=>['video','image-or-video'].includes(targetSpec(t)?.media)))b4.push(block('media_target_mismatch',scopeId,'P4','author','Выбрать совместимую видеоверсию и проверенный путь','compatible video target selected'));
  if(r.textBlocked)b4.push(block('text_limit',scopeId,'P4','author','Сократить описание','replacement description accepted'));
  if(!r.brief.trim())b4.push(block('brief_missing',scopeId,'P4','author','Ответить на карточку: что важно показать','brief supplied'));
  if(!r.targets.length||r.targets.some(t=>!t.account_ref||!t.format||!t.delivery_mode||t.readiness!=='passed'||!t.verified_at))b4.push(block('target_not_ready',scopeId,'P4','S0','Подтвердить путь выбранных площадок','target evidence passed'));
  if(r.rights.status!=='confirmed'||r.rights.manifestRevision!==r.manifest_revision||textOnly&&(r.rights.textHash?r.rights.textHash!==hash(r.brief):r.rights.textRevision!==r.brief_revision))b4.push(block('rights_unknown',scopeId,'P4','author',textOnly?'Подтвердить право использования текста':'Подтвердить права на текущий состав','rights confirmed for manifest or text'));
  if(r.timingQuestion)b4.push(block('timing_unanswered',scopeId,'P4','author','Ответить на карточку датой и временем','valid explicit moment'));
  if((!c.coordinators?.length&&c.coordinatorMode!=='operator-admin')||!c.approvers?.length)b4.push(block('roles_unset',scopeId,'P4','operator','Настроить роли','coordinator and approver configured'));
  if(!['A','B'].includes(c.handoffMode))b4.push(block('handoff_unset',scopeId,'P4','S0','Зафиксировать путь передачи','A or B verified'));
  if(!c.limits||['maxJobInput','maxJobOutput','maxCalls'].some(k=>!Number.isSafeInteger(c.limits[k])||c.limits[k]<=0))b4.push(block('budget_unset',scopeId,'P4','operator','Настроить лимиты','positive limits configured'));
  if(r.questions.some(q=>q.blocking&&q.status!=='resolved'))b4.push(block('question_open',scopeId,'P4','author','Ответить на вопрос','blocking questions resolved'));
  const j=Object.values(s.jobs).find(j=>j.materialId===id&&j.revision===r.revision&&j.status!=='superseded');
  const b5=j?.claim?[]:[block('not_claimed',scopeId,'P5','editor','Забрать задание','current job claimed')];
  let pilot;try{const trusted=pilotEvidence?.(),roles=[...new Set((c.targetCatalog||c.targets||[]).filter(t=>t.readiness==='passed').flatMap(t=>targetSpec(t)?.media==='image-or-video'?['S1','S2']:targetSpec(t)?.media==='video'?['S2']:['S1']))];pilot=evaluatePilot(trusted?.evidence,{version:trusted?.version,groupId:String(c.groupId),topicId:c.topicId,handoffMode:c.handoffMode,roles},clock());}catch{pilot={result:'unknown',reason:'pilot_evidence_unavailable',evidence:[]};}
  pilot.blockers=pilot.result==='passed'?[]:[block(pilot.reason,scopeId,'P0','S0','Подтвердить реальный контур пилота','fresh deployment and pilot receipt')];
  const gates={P0:pilot,P1:stage('passed',r,'P1'),P2:stage('passed',r,'P2',r.confirmedRevision===r.revision?[]:[block('manifest_unconfirmed',scopeId,'P2','author','Проверить состав','Подготовить так for current revision')]),
   P3:textOnly?{result:'not_applicable',reason:'text-only-material-no-binary-assets',blockers:[],evidence:r.evidence.filter(e=>e.type==='event')}:stage('passed',r,'P3',b3),P4:stage('passed',r,'P4',[...b4,...(r.confirmedRevision===r.revision?[]:[block('brief_unconfirmed',scopeId,'P4','author','Подготовить так','current revision confirmed')])]),
   P5:stage('passed',r,'P5',b5),P6:stage('passed',r,'P6',j?.status==='completed'&&j.artifactsVerified?[]:[block('result_missing',scopeId,'P6','editor','Подготовить проверяемые варианты','validated result exists')]),
   P7:stage('blocked',r,'P7',[block('queue_checks_pending',scopeId,'P7','editor','Проверить конечные варианты штатными проверками','versioned check evidence')]),
   P8:stage('blocked',r,'P8',[block('preview_pending',scopeId,'P8','editor','Передать конечные варианты на согласование','complete preview receipt')]),
   P9:stage('blocked',r,'P9',[block('not_publication_approval',scopeId,'P9','approver','Штатно согласовать конечный вариант','queue approval for actual payload')]),
   ...Object.fromEntries(['P10','P11','P12','P13'].map(p=>[p,stage('blocked',r,p,[block('queue_evidence_pending',scopeId,p,'queue','Продолжить штатную очередь после подготовки','actual queue receipt')])])),
   P14:stage('blocked',r,'P14',[block('backup_unverified',scopeId,'P14','S0','Подтвердить независимую копию и восстановление','backup and restore receipts')])};
  const targets=r.queueSummary?.targets||[];gates.targets=Object.fromEntries(targets.map(t=>[t.targetKey||targetKey(t.format?t:r.targets.find(x=>x.channel===t.channel)||t),t.stages||{}]));
  for(const t of targets)if(r.targets.filter(x=>x.channel===t.channel).length===1)gates.targets[t.channel]=t.stages||{};
  for(const p of ['P7','P8','P9','P10','P11','P12','P13']){
   const checks=r.targets.map(t=>targets.find(x=>(x.targetKey||targetKey(x))===targetKey(t)||!x.format&&r.targets.filter(a=>a.channel===t.channel).length===1&&x.channel===t.channel)?.stages?.[p]);
   if(checks.length&&checks.every(x=>x?.result==='passed'))gates[p]={result:'passed',blockers:[],evidence:checks.flatMap(x=>x.evidence||[])};
  }
  if(r.queueSummary?.stages?.P14?.result==='passed'&&r.queueSummary.stages.P14.artifact_ref)gates.P14={result:'passed',blockers:[],evidence:[r.queueSummary.stages.P14]};
  return gates;
 }
 function answerQuestion(s,r,q,e){const normalized=text=>String(text||'').trim().replace(/\s+/g,' '),meaningful=normalized(q.answer)!==normalized(e.text);if(!meaningful)return;
  if(q.answer){q.answers||=[{text:q.answer,by:q.answeredBy}];q.answers.push({text:e.text,by:e.author});q.status='conflict';}else q.status='answered';q.answer=e.text;q.answeredBy=e.author;
  r.answers_revision=(r.answers_revision||0)+1;const j=Object.values(s.jobs).find(j=>j.materialId===r.id&&currentJob(r,j)&&j.status==='claimed');if(j){j.answerRevision=r.answers_revision;j.answerHash=hash(r.questions.map(({id,status,answer,answers})=>({id,status,answer,answers:answers?.map(a=>a.text)})));}r.card.dirty=true;
 }
 function recoverTopicRootEvents(){const c=cfg();if(!c.enabled||!Number.isSafeInteger(c.topicId)||c.topicId<=0)return{ok:false,recovered:0};return store.tx(s=>{let recovered=0;
  for(const e of Object.values(s.events)){
   if(e.status!=='ignored'||e.kind!=='message'||e.reply!==c.topicId||!allowed(c,e.author)||e.materialId||(!e.file&&!e.text?.trim())||Object.values(s.materials).some(r=>r.sources.some(x=>x.messageId===e.messageId)))continue;
   e.recovery={kind:'forum-topic-root',at:now(),originalReply:e.reply};e.reply=null;e.status='pending';recovered++;
  }return{ok:true,recovered};});}
 function events(){store.tx(s=>{for(const e of Object.values(s.events)){if(e.status!=='pending'||e.kind==='callback')continue;
   let r=Object.values(s.materials).find(r=>e.reply&&(r.card.messageId===e.reply||r.sources.some(x=>x.messageId===e.reply)));
   if(!r&&e.file)r=Object.values(s.materials).find(r=>r.album&&r.album===e.album);
   // Незавершённая пачка одного автора объединяется только до первой карточки.
   // Разные явные альбомы, реальные replies, другие авторы и подтверждённое не смешиваются.
   if(!r&&!e.reply&&e.kind==='message'&&cfg().batchQuietMs>0)r=Object.values(s.materials).filter(m=>m.mode==='draft'&&m.card.status==='new'&&!m.card.messageId&&!m.confirmedRevision&&m.author===e.author&&(!e.album||!m.album||e.album===m.album)&&Number.isFinite(Date.parse(e.at))&&Date.parse(e.at)-Date.parse(m.lastSourceAt||m.createdAt)>=0&&Date.parse(e.at)-Date.parse(m.lastSourceAt||m.createdAt)<=cfg().batchQuietMs).sort((a,b)=>Date.parse(b.lastSourceAt||b.createdAt)-Date.parse(a.lastSourceAt||a.createdAt))[0];
   if(!r&&(e.file||e.text)&&e.kind!=='edited'&&!e.reply){
    if(Object.values(s.materials).filter(r=>!r.workflowClosed&&!['archive','cancelled','closed'].includes(r.mode)).length>=(cfg().limits?.maxPending||20)){e.status='blocked';e.reason='pending_limit';continue;}
    r={id:uid(),author:e.author,groupId:String(cfg().groupId),topicId:cfg().topicId||0,album:e.album,revision:1,manifest_revision:1,brief_revision:1,timing_revision:1,confirmedRevision:null,files:[],sources:[],brief:'',goal:'show-object',editing_mode:'adapt',targets:chooseTargets(cfg().targets||[],[]),targetsExplicit:false,targetAssets:{},timing:{mode:'after_approval',source:'project'},rights:{status:'needs_clarification'},questions:[],mode:'draft',createdAt:now(),updatedAt:now(),card:{status:'new',messageId:null,dirty:true},evidence:[]};s.materials[r.id]=r;
   }
   if(!r||!actorCan(cfg(),r,e.author)){e.status='ignored';continue;}
   if(r.workflowClosed||['archive','cancelled','closed'].includes(r.mode)){e.status='ignored';continue;}
   if(!e.file&&e.reply===r.card.messageId&&r.timingQuestion){const at=parseMaterialMoment(e.text);if(at){try{setTiming(s,r,{mode:r.timingQuestion,at,source:'author-explicit'});r.evidence.push(receipt('timing',r,'passed','message:'+e.messageId));r.timingQuestion=null;r.timingError=null;}catch{r.timingError='Срок уже передан в очередь: его меняет оператор штатной командой.';}}
    else r.timingError='Нужны дата и время: ДД.ММ.ГГГГ ЧЧ:ММ по Москве либо UTC с Z.';r.card.dirty=true;e.status='done';e.materialId=r.id;continue;}
   const old=r.sources.find(x=>x.messageId===e.messageId);
   if(r.sources.filter(x=>x!==old).reduce((n,x)=>n+x.caption.length,0)+e.text.length>(cfg().limits?.maxText||4000)){e.status='blocked';e.reason='text_limit';r.textBlocked=true;r.card.dirty=true;continue;}
   if(e.kind==='edited'&&!old){e.status='ignored';continue;}
   if(old){if(old.caption!==e.text){old.caption=e.text;const q=old.questionId&&r.questions.find(q=>q.id===old.questionId);if(q&&q.status!=='resolved')answerQuestion(s,r,q,e);else{r.facts=(r.facts||[]).filter(f=>f.sourceId!=='message-'+e.messageId);change(r,'brief');r.brief=r.sources.filter(x=>!x.questionId).map(x=>x.caption).filter(Boolean).join('\n');}}}
   else{const open=r.questions.filter(q=>['open','answered','conflict'].includes(q.status)),answering=!e.file&&!r.editRequested&&e.reply===r.card.messageId&&open.length===1;
    r.sources.push({...e.source,caption:e.text,...(answering?{questionId:open[0].id}:{})});
    if(e.text&&answering)answerQuestion(s,r,open[0],e);
    else if(e.text){r.brief=r.sources.filter(x=>!x.questionId).map(x=>x.caption).filter(Boolean).join('\n');r.editRequested=false;change(r,'brief');}
   }
   if(e.kind==='edited'&&e.file&&!r.files.some(f=>f.fileUniqueId===e.file.fileUniqueId&&f.messages.includes(e.messageId))){
    // Замена файла в исходном сообщении не удаляет сохранённый оригинал.
    for(const oldFile of r.files.filter(f=>f.messages.includes(e.messageId)))oldFile.excluded={reason:'replaced-in-source',by:e.author,at:now()};
   }
   if(e.file){const existing=r.files.find(f=>f.fileUniqueId===e.file.fileUniqueId);
    if(existing){if(!existing.messages.includes(e.messageId))existing.messages.push(e.messageId);}
    else if(r.files.length<(cfg().limits?.maxFiles||10)){r.files.push({...e.file,messageId:e.messageId,messages:[e.messageId],status:'pending',excluded:false});r.files.sort((a,b)=>a.messageId-b.messageId);change(r,'manifest');r.rights={status:'needs_clarification'};}
    else{e.status='blocked';e.reason='file_limit';r.limitBlocked=true;change(r,'manifest');continue;}
   }
   r.lastIncomingAt=clock();r.lastSourceAt=e.at;if(!r.album&&e.album)r.album=e.album;r.evidence.push(receipt('event',r,'passed','update:'+e.updateId));e.status='done';e.materialId=r.id;
  }});}
 function edit(id,revision,actor,patch){return store.tx(s=>{const r=s.materials[id];if(!r||!actorCan(cfg(),r,actor))throw Error('нет права менять комплект');if(r.revision!==revision)throw Error('устаревшая версия');if(r.workflowClosed||r.mode==='cancelled')throw Error('задание закрыто; нужен новый явный комплект');
   const keys=Object.keys(patch);if(keys.some(k=>!['goal','brief','targets','targetAssets','excludeFile','editing_mode','timing','rights','mode','resolveQuestion'].includes(k)))throw Error('неизвестная правка');
   for(const key of keys){const value=patch[key];
    if(key==='excludeFile'){const f=r.files.find(f=>f.fileUniqueId===value);if(!f)throw Error('файл не найден');f.excluded={by:String(actor),at:now()};change(r,'manifest');r.rights={status:'needs_clarification'};}
    else if(key==='rights'){if(value!==true)throw Error('нужно явное подтверждение');r.rights={status:'confirmed',manifestRevision:r.manifest_revision,by:String(actor),at:now()};change(r,'brief');r.rights.textRevision=r.brief_revision;r.rights.textHash=hash(r.brief);}
    else if(key==='targets'){if(!Array.isArray(value)||!value.length||new Set(value.map(targetKey)).size!==value.length||value.some(v=>!catalog().some(t=>hash(t)===hash(v))))throw Error('площадка не настроена');r.targets=clone(value);r.targetsExplicit=true;change(r,'brief');}
    else if(key==='targetAssets'){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('нужен состав по вариантам');for(const [target,ids]of Object.entries(value)){if(!catalog().some(t=>targetKey(t)===target)||!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!r.files.some(f=>f.fileUniqueId===id&&!f.excluded)))throw Error('неверный выбор вложений');}r.targetAssets=clone(value);change(r,'brief');refreshTargets(r);}
    else if(key==='mode'){if(!['draft','discussion','archive','cancelled'].includes(value))throw Error('неизвестный режим');r.mode=value;change(r,'brief');}
    else if(key==='goal'||key==='brief'){if(typeof value!=='string'||value.length>(cfg().limits?.maxText||4000))throw Error('неверный текст');r[key]=value;if(key==='brief')r.textBlocked=false;change(r,'brief');}
    else if(key==='editing_mode'){if(!['adapt','preserve_wording'].includes(value))throw Error('режим редактирования');r[key]=value;change(r,'brief');}
    else if(key==='timing'){setTiming(s,r,value);r.timingQuestion=null;r.timingError=null;}
    else if(key==='resolveQuestion'){const q=r.questions.find(q=>q.id===value?.id);if(!q||q.status==='resolved')throw Error('вопрос не найден');q.status='resolved';q.answer=String(value.answer||'').slice(0,1000);change(r,'brief');}
   }return r;
  });}
 function prepare(id,rev,actor){
  const r=store.read().materials[id];if(!r||!actorCan(cfg(),r,actor)||r.revision!==rev)return{ok:false,reason:'stale_or_forbidden'};
  if(r.workflowClosed)return{ok:false,reason:'workflow_closed'};
  const repeated=Object.values(store.read().jobs).find(j=>j.materialId===id&&j.revision===rev);if(r.mode==='submitted'&&repeated)return r.questions.some(q=>q.blocking&&q.status!=='resolved')?{ok:false,reason:'question_open'}:{ok:true,duplicate:true,jobId:repeated.id};
  if(r.workflowClosed||r.mode!=='draft')return{ok:false,reason:'mode'};
  const current=readiness(id),blocks=current.P4.blockers.filter(b=>b.reason_code!=='brief_unconfirmed');if(r.limitBlocked)blocks.push(block('file_limit','material:'+id,'P4','author','Разделить комплект','all files accounted'));
  if(blocks.length)return{ok:false,blockers:blocks};
  return store.tx(s=>{const m=s.materials[id];if(m.revision!==rev)return{ok:false};
   const existing=Object.values(s.jobs).find(j=>j.materialId===id&&j.revision===rev);if(existing)return{ok:true,duplicate:true,jobId:existing.id};
   if(Object.values(s.jobs).some(j=>j.materialId===id&&j.status==='claimed'))return{ok:false,reason:'previous_claim_active'};
   const input={materialId:id,revision:rev,manifestRevision:m.manifest_revision,briefRevision:m.brief_revision,brief:m.brief,goal:m.goal,targets:m.targets.map(t=>({...t,targetKey:targetKey(t)})),files:m.files.filter(f=>!f.excluded).map(f=>({mediaId:f.mediaId,sha256:f.sha256,mime:f.mime,bytes:f.bytes})),rights:{status:m.rights.status,manifestRevision:m.rights.manifestRevision},timing:m.timing,editing_mode:m.editing_mode,policyVersion:cfg().policyVersion,
    sources:m.sources.map(x=>({id:'message-'+x.messageId,kind:'author_statement',locator:x.link,text:x.caption,receivedAt:m.createdAt})).concat(m.factSources||[]),facts:(m.facts||[]).map(({claim,source})=>({claim,source})),targetFacts:clone(m.targetFacts||{}),targetMedia:Object.fromEntries(m.targets.map(t=>[targetKey(t),targetFiles(t,selectedFiles(m,t)).map(f=>f.mediaId)])),questions:m.questions.map(({id,text,status,answer,resolution})=>({id,text,status,answer,resolution}))};
   input.contentEpoch=m.content_epoch||0;input.budget=Object.fromEntries(['maxJobInput','maxJobOutput','maxCalls'].map(k=>[k,cfg().limits[k]]));
   if(JSON.stringify(input).length>cfg().limits.maxJobInput)return{ok:false,reason:'input_budget'};
   m.confirmedRevision=rev;m.mode='submitted';m.card.dirty=true;
   for(const old of Object.values(s.jobs))if(old.materialId===id&&old.status==='queued')old.status='superseded';
   const hasVideo=m.files.some(f=>!f.excluded&&f.mime?.startsWith('video/'));
   const j={id:uid(),protocolVersion:2,acceptedClaimsComplete:true,recipient:hasVideo?'S2':recipientFor(m.targets),manifestRevision:m.manifest_revision,materialId:id,revision:rev,inputHash:hash(input),input,targets:clone(input.targets),status:'queued',createdAt:now(),claim:null,result:null};s.jobs[j.id]=j;m.targetJobs=Object.fromEntries(j.targets.map(t=>[targetKey(t),j.id]));m.evidence.push(receipt('brief-confirmation',m,'passed',j.id));return{ok:true,jobId:j.id};
  });
 }
 async function callbacks(){for(const event of Object.values(store.read().events).filter(e=>e.kind==='callback'&&e.status==='pending')){
  const match=/^mi:([a-f0-9]{16}):(\d+):([a-z0-9_-]+)$/.exec(event.data);let answer='Откройте текущую карточку';
  if(match){const [,id,ver,action]=match,r=store.read().materials[id];if(r&&!r.workflowClosed&&r.card.messageId===event.messageId&&r.revision===Number(ver)&&actorCan(cfg(),r,event.actor)){
   try{
    if(action==='prepare'){const res=prepare(id,Number(ver),event.actor);answer=res.ok?'Задание передано. Это не одобрение публикации.':res.blockers?.[0]?.next_action||'Передача пока невозможна';}
    else if(action==='rights'){edit(id,Number(ver),event.actor,{rights:true});answer='Подтверждение сохранено';}
    else if(['archive','cancel','discuss'].includes(action)){edit(id,Number(ver),event.actor,{mode:{archive:'archive',cancel:'cancelled',discuss:'discussion'}[action]});answer='Решение сохранено';}
    else if(action==='object'||action==='product'||action==='other'){edit(id,Number(ver),event.actor,{goal:action});answer='Цель изменена';}
    else if(action==='time-now'||action==='time-later'){edit(id,Number(ver),event.actor,{timing:{mode:action==='time-now'?'after_approval':'choose_later',source:'author-explicit'}});answer='Срок обновлён; готовый текст не меняется';}
    else if(action==='time-at'||action==='time-not-before'){store.tx(s=>{const m=s.materials[id];m.timingQuestion=action==='time-at'?'at':'not_before';m.card.dirty=true;});answer='Ответьте на карточку: ДД.ММ.ГГГГ ЧЧ:ММ по Москве';}
    else if(action.startsWith('fmt-')){const t=catalog().find(t=>targetToken(t)===action.slice(4));if(t){const selected=r.targets.some(x=>targetKey(x)===targetKey(t)),next=selected?r.targets.filter(x=>targetKey(x)!==targetKey(t)):[...r.targets,t];if(!next.length)answer='Нужно оставить хотя бы один вариант';else{edit(id,Number(ver),event.actor,{targets:next});answer='Список вариантов изменён';}}}
    else if(action.startsWith('asset-')){const parts=action.split('-'),t=catalog().find(t=>targetToken(t)===parts[1]),file=r.files[Number(parts[2])];if(t&&file&&!file.excluded){const key=targetKey(t),old=r.targetAssets?.[key]||targetFiles(t,r.files).map(f=>f.fileUniqueId),ids=old.includes(file.fileUniqueId)?old.filter(x=>x!==file.fileUniqueId):[...old,file.fileUniqueId];edit(id,Number(ver),event.actor,{targetAssets:{...(r.targetAssets||{}),[key]:ids}});answer='Состав варианта изменён';}}
    else if(action.startsWith('target-')){const channel=action.slice(7),t=cfg().targets.find(x=>x.channel===channel);if(t){const selected=r.targets.some(x=>targetKey(x)===targetKey(t));edit(id,Number(ver),event.actor,{targets:selected?r.targets.filter(x=>targetKey(x)!==targetKey(t)):[...r.targets,t]});answer='Площадки изменены';}}
    else if(action.startsWith('omit-')){const qid=action.slice(5);store.tx(s=>{const m=s.materials[id],q=m.questions.find(q=>q.id===qid&&q.allowOmit);if(!q||q.status==='resolved')throw Error();q.status='resolved';q.resolution='omit';q.by=event.actor;change(m,'brief');});answer='Спорное утверждение исключается из подготовки';}
    else if(action==='reopen'&&['archive','discussion'].includes(r.mode)){edit(id,Number(ver),event.actor,{mode:'draft'});answer='Возвращено в подготовку задания; публикация не одобрена';}
    else if(action==='edit'){store.tx(s=>{s.materials[id].editRequested=true;s.materials[id].card.dirty=true;});answer='Ответьте на карточку: цель или описание. Площадки меняются кнопками.';}
   }catch{answer='Действие не применено: откройте текущую карточку';}
  }}
  store.tx(s=>{s.events['cb:'+event.id].status='done';});if(telegram)await telegram('answerCallbackQuery',{callback_query_id:event.id,text:answer});
 }}
 function receiptProgress(r){
  if(!cfg().batchQuietMs||r.workflowClosed||['archive','cancelled','closed','discussion'].includes(r.mode))return{code:'inactive',text:''};
  if(r.files.some(f=>!f.excluded&&f.status==='failed'))return{code:'file-failed',text:'Не все файлы удалось сохранить. Сообщения сохранены; оператору нужно проверить загрузку. Повторно отправлять всю пачку не нужно.'};
  if(r.questions.some(q=>q.blocking&&q.status!=='resolved'))return{code:'question',text:'Нужно уточнение. Ответьте на вопрос в этой карточке; материал не потерян.'};
  if(r.mode!=='submitted')return{code:'received',text:'Материалы получены. Проверьте состав и права на использование, затем нажмите «Подготовить так». Это ещё не одобрение публикации.'};
  const jobs=Object.values(store.read().jobs).filter(j=>j.materialId===r.id&&currentJob(r,j)),claimed=jobs.find(j=>j.status==='claimed');
  if(claimed){const late=clock()-Date.parse(claimed.claim?.at)>15*60*1000;return{code:late?'editor-delayed':'editor-accepted',text:late?'Подготовка затянулась. Материалы сохранены; требуется проверка оператора. Повторная передача не запускается.':'Редактор принял материал в обработку. Готовые варианты появятся на согласовании; срок готовности зависит от объёма.'};}
  if(jobs.length&&jobs.every(j=>j.status==='completed'))return{code:'prepared',text:'Варианты подготовлены. Передаём их на отдельное согласование; без «Одобрить» публикации не будет.'};
  const oldest=Math.min(...jobs.filter(j=>j.status==='queued').map(j=>Date.parse(j.createdAt)));const late=Number.isFinite(oldest)&&clock()-oldest>120000;
  return{code:late?'dispatch-delayed':'editor-waiting',text:late?'Задержка передачи: редактор ещё не подтвердил приём. Материалы сохранены; оператору нужно проверить доставку.':'Ожидает приёма редактором. Контрольный срок подтверждения — 2 минуты; если он истечёт, здесь появится статус задержки.'};
 }
 function card(id){const r=store.read().materials[id];if(!r)throw Error('комплект не найден');const active=r.files.filter(f=>!f.excluded),verified=active.filter(f=>f.status==='verified');
  const currentJob=Object.values(store.read().jobs).find(j=>j.materialId===id&&j.revision===r.revision),snapshots=r.queueSummary?.targets||Object.values(currentJob?.publicationState||{});
  const counts=r.queueSummary?{published_count:snapshots.filter(x=>x.stages?.P12?.result==='passed').length,cancelled_count:snapshots.filter(x=>x.status==='cancelled').length,deferred_count:0,unresolved_count:snapshots.filter(x=>!x.closed).length}:r.workflowSummary;
  const state=r.workflowClosed?'Итог':{draft:'Собираем материал',submitted:snapshots.some(x=>['approved','running','handed','published','failed','expired'].includes(x.status))?'Выпуск':snapshots.some(x=>['review','rework'].includes(x.status))?'На согласовании':currentJob?.claim?'В подготовке':'Ожидает подготовки',discussion:'Только обсуждение',archive:'В архиве; резервирование не подтверждено',cancelled:'Отменено',closed:'Итог'}[r.mode];
  const titles={telegram:'Telegram',vk:'ВКонтакте',instagram:'Instagram',threads:'Threads',dzen:'Дзен',youtube:'YouTube',rutube:'Rutube'},formats={album:'альбом',photopost:'пост с фото','photo-post':'пост с фото',carousel:'карусель',post:'пост',video:'видео'},goals={'show-object':'показать объект',object:'показать объект',product:'объяснить продукт',other:'другая цель'};
  const lines=[`<b>${safe(state)}</b>`,...(cfg().batchQuietMs?[`Принято сообщений: ${r.sources.length}. ${safe(receiptProgress(r).text)}`]:[]),`Сохранено ${verified.length} из ${active.length} файлов.`,r.changedAfterTransfer?'Состав изменён после передачи. Нужна новая версия задания.':'',`Предложение: ${safe(goals[r.goal]||r.goal||'предложить подачу')}.`,
   `Подготовим: ${r.targets.map(t=>{const problems=targetProblems(t,selectedFiles(r,t));return safe(`${titles[t.channel]||t.channel} — ${targetSpec(t)?.label||formats[t.format]||t.format} (${t.delivery_mode==='manual'?'ручная выкладка':'автоматическая публикация'})${problems.length?'; пока нельзя: '+problems.map(p=>p.reason).join(', '):''}`);}).join('; ')||'нет подходящих выбранных форматов'}.`,
   ...catalog().filter(t=>t.readiness!=='passed'&&!r.targets.some(x=>targetKey(x)===targetKey(t))).map(t=>`${safe(channelTitle(t.channel))}: ${safe(t.reason||'путь ещё не проверен')}.`),r.brief?`Описание: ${safe(r.brief.slice(0,1400))}`:'Нужен ответ: опишите, что важно показать. Ответьте на эту карточку.',
   r.rights.status==='confirmed'?'Права на текущий состав подтверждены.':active.length?'Нужен ответ: подтвердите право публично использовать текущие файлы. Людей/музыку при необходимости проверит редактор; дети в кадре запрещены.':'Нужен ответ: подтвердите право публично использовать этот текст.',
   active.some(f=>f.mime?.startsWith('video/'))&&!r.targets.some(t=>['video','image-or-video'].includes(targetSpec(t)?.media))?'Выберите совместимую видеоверсию и проверенный путь доставки.':'',
   r.timingQuestion?'Ответьте на эту карточку: ДД.ММ.ГГГГ ЧЧ:ММ по Москве либо UTC с Z.':'',r.timingError||'',
   snapshots.some(t=>t.date&&t.time)?`Сроки по штатной очереди: ${snapshots.filter(t=>t.date&&t.time).map(t=>safe(`${titles[t.channel]||t.channel} — ${t.date} ${t.time} МСК${t.timing_mode==='not-before'?' (не раньше)':''}`)).join('; ')}.`:r.timing.mode==='choose_later'?'Выпуск отложен до выбора времени; «Одобрить» не отменяет это условие.':r.timing.at?`Выпуск ${r.timing.mode==='not_before'?'не раньше':'точно'} ${safe(new Date(r.timing.at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}))} (Москва), после отдельного «Одобрить».`:'Выпуск: после отдельного «Одобрить» готового варианта каждой площадки.',
   r.limitBlocked?'Есть непринятые файлы: лимит комплекта. Нужен координатор, чтобы явно разделить комплект; передача остановлена.':'',
   r.textBlocked?'Описание превышает предел пилота. Нужен сокращённый ответ или разделение задания.':'',
   r.editRequested?'Ответьте на эту карточку новым описанием.':'',...r.questions.filter(q=>q.status!=='resolved').map(q=>`Нужен ваш ответ: ${safe(q.text)}${q.status==='answered'?' Ответ получен; редактор проверяет источник.':''}`),...r.files.filter(f=>f.status==='failed'&&!f.excluded).map(f=>`Не сохранён файл: ${safe(f.errorCode)}. Для большого видео — закрытая передача оператором в медиатеку.`),
   ...snapshots.map(x=>`${titles[x.channel]||x.channel}: ${x.publishedVerified||x.stages?.P12?.result==='passed'?'опубликовано':({review:'ждёт одобрения',rework:'нужна правка',approved:'одобрено',running:'отправляется',handed:'ожидает ручной выкладки',failed:'нужен технический владелец',cancelled:'отменено',expired:'срок истёк',published:'выход ещё не проверен'})[x.status]||'ожидает передачи'}${(x.publishedVerified||x.stages?.P12?.result==='passed')&&x.link?' — '+safe(x.link):''}.`),
   counts?`Подтверждённо опубликовано: ${counts.published_count}; отменено: ${counts.cancelled_count}; отложено: ${counts.deferred_count}; открыто: ${counts.unresolved_count}.`:'',
   ...(r.previousQueueSummaries||[]).flatMap(p=>p.summary.targets.filter(t=>t.link&&t.stages?.P12?.result==='passed').map(t=>`Предыдущая версия, ${titles[t.channel]||t.channel}: ${safe(t.link)}`)) ];
  const data=action=>`mi:${r.id}:${r.revision}:${action}`;
  const buttons=r.workflowClosed||['cancelled','closed'].includes(r.mode)?[]:['archive','discussion'].includes(r.mode)?[[{text:'Вернуть к заданию',callback_data:data('reopen')}]]:[[{text:'Подготовить так',callback_data:data('prepare')},{text:'Изменить задание',callback_data:data('edit')}],
   [{text:'Только обсудить',callback_data:data('discuss')},{text:'В архив',callback_data:data('archive')}],...(r.rights.status!=='confirmed'?[[{text:'Право использования подтверждаю',callback_data:data('rights')}]]:[]),
   ...r.questions.filter(q=>q.status!=='resolved'&&q.allowOmit).map(q=>[{text:'Не использовать спорное утверждение',callback_data:data('omit-'+q.id)}]),
   ...(r.editRequested?[[{text:'Показать объект',callback_data:data('object')},{text:'Объяснить продукт',callback_data:data('product')},{text:'Другое',callback_data:data('other')}],
    ...catalog().map(t=>[{text:(r.targets.some(x=>targetKey(x)===targetKey(t))?'✓ ':'')+channelTitle(t.channel)+' — '+(targetSpec(t)?.label||t.format),callback_data:data('fmt-'+targetToken(t))}]),
    ...r.targets.filter(t=>(targetSpec(t)?.max||Infinity)<targetFiles(t,r.files).length||r.targetAssets?.[targetKey(t)]).flatMap(t=>r.files.map((f,i)=>[{text:(selectedFiles(r,t).includes(f)?'✓ ':'')+(targetSpec(t)?.label||t.format)+': файл '+(i+1),callback_data:data('asset-'+targetToken(t)+'-'+i)}])),
    [{text:'После Одобрить сразу',callback_data:data('time-now')},{text:'Время позже',callback_data:data('time-later')}],
    [{text:'В точное время',callback_data:data('time-at')},{text:'Не раньше',callback_data:data('time-not-before')}]]:[]),[{text:'Отменить',callback_data:data('cancel')}]];
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
    store.tx(s=>{const m=s.materials[r.id],item=m.files.find(x=>x.fileUniqueId===f.fileUniqueId);Object.assign(item,errorCode?{status:'failed',errorCode}:{status:'verified',mediaId:result.mediaId,sha256:result.sha256,bytes:result.bytes,mime:result.mime});if(!errorCode)refreshTargets(m);m.card.dirty=true;m.evidence.push(receipt('file',m,errorCode?'failed':'passed',errorCode||result.mediaId));});
   }
   if(cfg().batchQuietMs){const refresh=Object.values(store.read().materials).filter(r=>!['archive','cancelled','closed','discussion'].includes(r.mode)&&!r.workflowClosed&&!r.card.dirty&&r.card.receiptStage!==receiptProgress(r).code).map(r=>r.id);if(refresh.length)store.tx(s=>{for(const id of refresh)s.materials[id].card.dirty=true;});}
   for(const r of Object.values(store.read().materials)){if(!telegram||!r.card.dirty||['sending','unknown','failed'].includes(r.card.status)||(r.card.retryAt||0)>clock()||clock()-(r.lastIncomingAt||0)<(cfg().quietMs||0))continue;
    const content=card(r.id),first=!r.card.messageId;
    if(first)store.tx(s=>{s.materials[r.id].card.status='sending';s.materials[r.id].card.attemptedAt=now();});
    let res;try{res=await telegram(first?'sendMessage':'editMessageText',{chat_id:r.groupId,...(r.topicId?{message_thread_id:r.topicId}:{}),...(first?{reply_parameters:{message_id:r.sources[0].messageId,allow_sending_without_reply:true}}:{message_id:r.card.messageId}),parse_mode:'HTML',...content});}catch{res={ok:false,uncertain:true};}
    store.tx(s=>{const m=s.materials[r.id];if(res.ok&&(res.messageId||!first)){m.card={status:'sent',messageId:res.messageId||m.card.messageId,dirty:m.revision!==r.revision,revision:r.revision,...(cfg().batchQuietMs?{receiptStage:receiptProgress(r).code}:{})};m.evidence.push(receipt('card',m,'passed','message:'+m.card.messageId));}else{m.card.attempts=(m.card.attempts||0)+1;const known=res.ok===false&&res.uncertain===false;m.card.status=first&&!known?'unknown':m.card.attempts>=3?'failed':first?'new':'sent';m.card.retryAt=clock()+30000;m.card.dirty=true;}});
   }return{ok:true};
  }finally{unlock();}
 }
 function claim(id,owner,requestId,expected){if(!['S1','S2'].includes(owner))return{ok:false,reason:'owner'};if(requestId!==undefined&&!/^[a-f0-9]{32}$/.test(requestId))return{ok:false,reason:'request_id'};
  return store.tx(s=>{const j=s.jobs[id],m=j&&s.materials[j.materialId];
   if(j?.protocolVersion===2&&j.recipient!==owner)return{ok:false,reason:'recipient'};
   const duplicate=j?.status==='claimed'&&requestId&&j.claim.owner===owner&&j.claim.requestId===requestId;
   if(expected!==undefined&&(!expected||typeof expected!=='object'||Array.isArray(expected)||!j||Object.keys(expected).some(k=>!['materialId','revision','inputHash','protocolVersion','manifestRevision'].includes(k))||expected.materialId!==j.materialId||expected.revision!==j.revision||expected.inputHash!==(duplicate?j.claim.initialInputHash||j.inputHash:j.inputHash)||['protocolVersion','manifestRevision'].some(k=>expected[k]!==undefined&&expected[k]!==j[k])))return{ok:false,reason:'expected_job_mismatch'};
   if(duplicate)return currentJob(m,j)?{ok:true,duplicate:true,token:j.claim.token,job:clone(j)}:{ok:false,reason:'busy_or_stale'};
   if(!cfg().enabled||!j||j.status!=='queued'||!currentJob(m,j)||Object.values(s.jobs).some(other=>other.materialId===j.materialId&&other.status==='claimed'))return{ok:false,reason:'busy_or_stale'};
   j.status='claimed';j.claim={owner,token:uid(),initialInputHash:j.inputHash,at:now(),...(requestId?{requestId}:{})};j.acceptedClaims||=[];j.acceptedClaims.push({requestId:requestId||null,owner,initialInputHash:j.inputHash,at:j.claim.at});j.delivery={mode:cfg().handoffMode,at:now(),result:'accepted'};m.card.dirty=true;m.evidence.push(receipt('claim',m,'passed',j.id));return{ok:true,token:j.claim.token,job:clone(j)};
  });}
 function result(id,owner,token,value){return store.tx(s=>{const j=s.jobs[id],m=j&&s.materials[j.materialId];if(!j||j.claim?.owner!==owner||j.claim.token!==token)return{ok:false,reason:'claim'};
  if(!currentJob(m,j))return{ok:false,reason:'stale'};const digest=hash(value);if(j.status==='completed')return{ok:j.resultHash===digest,duplicate:j.resultHash===digest};
  if(value?.inputHash!==j.inputHash||!Array.isArray(value.variants)||JSON.stringify(value).length>Math.min(cfg().limits.maxJobOutput,j.input.budget?.maxJobOutput||Infinity))return{ok:false,reason:'schema'};
  const wanted=new Set(j.targets.map(targetKey));if(value.variants.length!==wanted.size||new Set(value.variants.map(targetKey)).size!==wanted.size)return{ok:false,reason:'targets'};
  for(const v of value.variants){const spec=targetSpec(v),content=typeof v.text==='string'&&v.text.trim()||Array.isArray(v.entry?.posts)&&v.entry.posts.some(p=>typeof p==='string'&&p.trim());if(!wanted.has(targetKey(v))||!spec||!content||!Array.isArray(v.mediaIds)||spec.min&&!v.mediaIds.length||v.mediaIds.some(id=>typeof id!=='string'))return{ok:false,reason:'variant'};}
  if(!verifyResult||!verifyResult(value,j))return{ok:false,reason:'artifact_verification'};
  j.result=clone(value);j.resultHash=digest;j.artifactsVerified=true;j.status='completed';j.completedAt=now();m.card.dirty=true;m.evidence.push(receipt('editor-result',m,'passed',j.id));return{ok:true,publicationApproved:false};
 });}
 function question(id,owner,token,value){return store.tx(s=>{const j=s.jobs[id],r=j&&s.materials[j.materialId];if(!j||j.status!=='claimed'||j.claim.owner!==owner||j.claim.token!==token||!currentJob(r,j))return{ok:false,reason:'claim'};
  if(typeof value?.text!=='string'||!value.text.trim()||value.text.length>600||r.questions.filter(q=>q.status!=='resolved').length>=1)return{ok:false,reason:'question'};
  r.questions.push({id:uid(),text:value.text,blocking:true,allowOmit:value.allowOmit===true,status:'open',ownerRole:owner,inputRevision:r.revision});r.questions_revision=(r.questions_revision||0)+1;r.card.dirty=true;return{ok:true,revision:r.revision};
 });}
 function facts(id,revision,jobId,owner,token,value){return store.tx(s=>{
  const r=clone(s.materials[id]),j=clone(s.jobs[jobId]);if(!r||!j||j.materialId!==id||j.status!=='claimed'||j.claim?.owner!==owner||j.claim.token!==token||!currentJob(r,j)||revision!==j.revision&&revision!==r.revision)return{ok:false,reason:'claim_or_revision'};
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
   if(!q)return{ok:false,reason:'question'};if(q.status==='conflict')return{ok:false,reason:'coordinator_resolution_required'};
   if(resolution.type==='omit'){if(!q.allowOmit)return{ok:false,reason:'omit_not_allowed'};}
   else if(resolution.type==='source'){if(!Array.isArray(resolution.claims)||!resolution.claims.length||resolution.claims.some(claim=>!checked.some(f=>f.claim===claim&&f.sourceId===resolution.sourceId)))return{ok:false,reason:'question_source'};}
   else return{ok:false,reason:'resolution_type'};
  }
  const targetFacts={};if(value.targetFacts!==undefined){if(!value.targetFacts||typeof value.targetFacts!=='object'||Array.isArray(value.targetFacts))return{ok:false,reason:'target_facts'};
   for(const [key,claims]of Object.entries(value.targetFacts)){const t=r.targets.find(t=>targetKey(t)===key);if(!t||!Array.isArray(claims)||claims.some(claim=>!checked.some(f=>f.claim===claim)))return{ok:false,reason:'target_facts'};targetFacts[key]=checked.filter(f=>claims.includes(f.claim)).map(({claim,source})=>({claim,source}));}}
  r.facts=checked;r.targetFacts=targetFacts;r.factSources=sources.filter(s=>s.kind!=='author_statement');r.facts_revision=(r.facts_revision||0)+1;
  for(const resolution of resolutions){const q=r.questions.find(q=>q.id===resolution.questionId);q.status='resolved';q.resolution=resolution.type;q.sourceId=resolution.sourceId||null;q.claims=resolution.claims||[];q.checkedBy=owner;}
  // Аннотация уже принятого содержания не меняет клиентское задание/manifest.
  // Меняем только зависимости редакторского пакета; прежний результат с иным hash отвергается.
  const updatedInput={...j.input,facts:r.facts.map(({claim,source})=>({claim,source})),targetFacts:clone(r.targetFacts),sources,questions:r.questions.map(({id,text,status,answer,resolution})=>({id,text,status,answer,resolution})),factsRevision:r.facts_revision};
  if(JSON.stringify(updatedInput).length>Math.min(cfg().limits.maxJobInput,j.input.budget?.maxJobInput||Infinity))return{ok:false,reason:'input_budget'};
  j.input=updatedInput;j.inputHash=hash(j.input);
  r.card.dirty=true;s.materials[id]=r;s.jobs[jobId]=j;return{ok:true,revision:r.revision,factsRevision:r.facts_revision,inputHash:j.inputHash,job:clone(j)};
 });}
 function context(id,owner,token){const s=store.read(),j=s.jobs[id],r=j&&s.materials[j.materialId];if(!j||j.status!=='claimed'||j.claim?.owner!==owner||j.claim.token!==token||!currentJob(r,j))return{ok:false,reason:'claim'};
  const job=clone(j);delete job.claim.token;delete job.previousClaim;
  return{ok:true,revision:r.revision,materialId:r.id,mode:r.mode,job,answerRevision:j.answerRevision||0,answerHash:j.answerHash||null,questions:r.questions.map(({id,text,status,answer,resolution,sourceId,answers})=>({id,text,status,answer,resolution,sourceId,answers:answers?.map(a=>a.text)})),sources:r.sources.map(x=>({id:'message-'+x.messageId,kind:'author_statement',locator:x.link,text:x.caption,questionId:x.questionId})).concat(r.factSources||[]),facts:(r.facts||[]).map(({claim,source})=>({claim,source})),manifestRevision:r.manifest_revision};
 }
 // Dispatcher получает только метаданные. Ответ читается прежним владельцем через context.
 // eventKey служит durable-дедупом доставки; ожидание без нового ответа событий не создаёт.
 function continuations(){if(!cfg().enabled)return[];const s=store.read();return Object.values(s.jobs).filter(j=>j.status==='claimed'&&j.answerRevision&&currentJob(s.materials[j.materialId],j)).map(j=>({eventKey:`answer:${j.id}:${j.answerRevision}:${j.answerHash}`,kind:'answer',jobId:j.id,materialId:j.materialId,revision:j.revision,recipient:j.claim.owner,requestId:j.claim.requestId||null,answerRevision:j.answerRevision,answerHash:j.answerHash,inputHash:j.inputHash}));}
 function isCurrentTarget(jobId,key){const s=store.read(),j=s.jobs[jobId],r=j&&s.materials[j.materialId];return currentTarget(r,j,key);}
 // Только доверенное чтение очереди. Поля note/status/hash не принимаются от модели.
 // Старый completed/result остаётся неизменным; новая работа охватывает ровно один target.
 function queueFeedback(jobId,key){return store.tx(s=>{
  const old=s.jobs[jobId],r=old&&s.materials[old.materialId],target=old?.targets.find(t=>targetKey(t)===key);
  if(!cfg().enabled||!getQueueEntry||!r||!target||old.status!=='completed'||!old.artifactsVerified)return{ok:false,reason:'trusted_feedback_required'};
  const ref=old.queueResults?.[key]||(old.targets.filter(t=>t.channel===target.channel).length===1?old.queueResults?.[target.channel]:null),entry=ref?.id?getQueueEntry(ref.id):null;
  if(!entry||entry.status!=='rework'||entry.material!=='intake:'+r.id||entry.channel!==target.channel||entry.contentHash!==ref.contentHash||typeof entry.note!=='string'||!entry.note.trim()||entry.note.length>1500)return{ok:false,reason:'queue_feedback_mismatch'};
  const noteHash=hash(entry.note),feedbackKey=hash({jobId,key,entryId:entry.id,contentHash:entry.contentHash,noteHash}),prior=r.feedbackJobs?.[feedbackKey];if(prior)return{ok:true,duplicate:true,jobId:prior};
  if(!currentTarget(r,old,key)||Object.values(s.jobs).some(j=>j.materialId===r.id&&j.status==='claimed'))return{ok:false,reason:'stale_or_claimed'};
  const previous=old.result?.variants?.find(v=>targetKey(v)===key);if(!previous)return{ok:false,reason:'previous_target_missing'};
  const previousResult={channel:target.channel,format:target.format,text:previous.text,mediaIds:clone(previous.mediaIds||[]),entry:Object.fromEntries(['title','text','posts','facts'].filter(k=>previous.entry?.[k]!==undefined).map(k=>[k,clone(previous.entry[k])]))};
  if(previous.entry?.media)previousResult.entry.media=previous.entry.media.map(m=>Object.fromEntries(['type','mediaId','coverMediaId'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]])));
  const revision=r.revision+1,input={...clone(old.input),revision,targets:[clone(target)],targetMedia:{[key]:clone(old.input.targetMedia?.[key]||[])},targetFacts:{[key]:clone(old.input.targetFacts?.[key]||old.input.facts||[])},questions:[],rework:{previousJobId:old.id,targetKey:key,entryId:entry.id,contentHash:entry.contentHash,note:entry.note,noteHash,feedbackKey,previousResult,trust:'queue-feedback-content-untrusted'}};
  input.budget||=Object.fromEntries(['maxJobInput','maxJobOutput','maxCalls'].map(k=>[k,cfg().limits[k]]));
  if(JSON.stringify(input).length>Math.min(input.budget.maxJobInput,cfg().limits.maxJobInput))return{ok:false,reason:'input_budget'};
  const j={id:uid(),protocolVersion:2,acceptedClaimsComplete:true,recipient:old.recipient||recipientFor([target]),manifestRevision:r.manifest_revision,materialId:r.id,revision,inputHash:hash(input),input,targets:clone(input.targets),status:'queued',createdAt:now(),claim:null,result:null,parentJobId:old.id,scope:'target-rework'};
  r.targetJobs||=Object.fromEntries(old.targets.map(t=>[targetKey(t),old.id]));r.targetJobs[key]=j.id;r.feedbackJobs||={};r.feedbackJobs[feedbackKey]=j.id;
  if(r.queueSummary){r.previousQueueSummaries||=[];r.previousQueueSummaries.push({revision:r.revision,summary:clone(r.queueSummary)});delete r.queueSummary;}
  r.revision=revision;r.confirmedRevision=revision;r.workflowClosed=false;r.card.dirty=true;r.updatedAt=now();s.jobs[j.id]=j;r.evidence.push(receipt('queue-rework',r,'passed',entry.id));return{ok:true,jobId:j.id,revision,targetKey:key,noteHash};
 });}
 function release(id,owner,token){return store.tx(s=>{const j=s.jobs[id];
  if(j?.previousClaim?.owner===owner&&j.previousClaim.token===token)return{ok:true,duplicate:true,status:j.status};
  if(!j||j.claim?.owner!==owner||j.claim.token!==token)return{ok:false,reason:'claim'};if(j.status!=='claimed')return{ok:false,reason:'status'};j.status=currentJob(s.materials[j.materialId],j)?'queued':'superseded';j.previousClaim=j.claim;j.claim=null;return{ok:true,status:j.status};});}
 function retry(id,revision,actor){return store.tx(s=>{const r=s.materials[id];if(!r||r.revision!==revision||!actorCan(cfg(),r,actor))throw Error('нет права или версия устарела');for(const f of r.files)if(f.status==='failed')f.status='pending';return{ok:true};});}
 return{ingest,flush,handleUpdate:async u=>{const r=ingest(u);await flush();return r;},list:()=>Object.values(store.read().materials).map(r=>({id:r.id,revision:r.revision,mode:r.mode,files:r.files.length})),show:id=>clone(store.read().materials[id]),
  readiness,card,edit,prepare,jobs:()=>Object.values(store.read().jobs).map(clone),claim,result,question,facts,context,continuations,isCurrentTarget,queueFeedback,release,retry,recoverTopicRootEvents,store};
}
