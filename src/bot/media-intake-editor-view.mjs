// Минимальный редакторский пакет отдельно от закрытой квитанции владения.
// Авторы/токены/переписка/ссылки на оригиналы остаются на сервере и в закрытом consumer.
import {createHash} from 'node:crypto';
import {targetKey,targetEntryName,targetSpec} from './media-intake-targets.mjs';
const text=(value,max)=>{const s=String(value||''),phone=(s.match(/\+?\d[\d ()-]{7,}\d/gu)||[]).some(v=>v.replace(/\D/g,'').length>=10);if(s.length>max||phone||/[\w.+-]+@[\w.-]+\.[a-z]{2,}|Bearer\s|[?&](?:access_token|token|secret|signature|key)=|BEGIN.*PRIVATE KEY|https?:\/\/[^\s/]+@/iu.test(s))throw Error('privacy review required');return s;};
const publicSource=value=>{try{const u=new URL(value);return u.protocol==='https:'&&['ecopolisrf.ru','www.ecopolisrf.ru','ecopolisgo.ru'].includes(u.hostname)&&!u.username&&!u.password&&!u.search?u.href:null;}catch{return null;}};
const sourceId=s=>/^[a-z0-9-]{1,64}$/.test(s?.id||'')?s.id:undefined;
const sourceKind=s=>['client-page','client-document','author_statement'].includes(s?.kind)?s.kind:'unknown';
const budgetView=b=>b&&['maxJobInput','maxJobOutput','maxCalls'].every(k=>Number.isSafeInteger(b[k])&&b[k]>0)?Object.fromEntries(['maxJobInput','maxJobOutput','maxCalls'].map(k=>[k,b[k]])):null;
function priorVariant(input){
 const v=input.rework?.previousResult||input.previousResult;if(!v)return undefined;
 if(targetKey(v)!==input.rework?.targetKey)throw Error('previous target mismatch');
 const e=v.entry||v,ids=v.mediaIds||[];if(!Array.isArray(ids)||ids.some(id=>!/^med_[a-f0-9]{32}$/.test(id)))throw Error('previous media identity');
 return{channel:v.channel,format:v.format,text:text(v.text||e.text,12000),...(e.title?{title:text(e.title,200)}:{}),...(Array.isArray(e.posts)?{posts:e.posts.map(p=>text(p,3000))}:{}),mediaIds:ids,factRefs:(e.facts||[]).map(f=>text(f.claim,1000))};
}
export function editorSourceView(claim,id){
 editorTaskView(claim);
 const source=(claim.context?.sources||claim.job.input.sources||[]).find(s=>sourceId(s)===id);
 if(!source||!['client-page','client-document'].includes(source.kind))throw Error('private source requires separate review');
 // Переписка не выдаётся; документ/страница возвращается целиком в пределах лимита.
 // Длинный документ требует явно зарегистрированного отдельного фрагмента.
 return{sourceId:id,kind:source.kind,...(publicSource(source.locator)?{url:publicSource(source.locator)}:{}),text:text(source.text,6000),sha256:createHash('sha256').update(String(source.text||'')).digest('hex')};
}
export function editorTaskView(claim){
 const job=claim?.job,input=job?.input;
 if(claim?.schema!==1||!/^[a-f0-9]{16}$/.test(job?.id||'')||!/^[a-f0-9]{16}$/.test(job?.materialId||'')||!/^[a-f0-9]{64}$/.test(job?.inputHash||'')||!Number.isSafeInteger(job?.revision)||job.revision<=0||!input||!['S1','S2'].includes(claim.owner))throw Error('invalid editor claim');
 const rawSources=claim.context?.sources||input.sources||[];
 const sources=rawSources.slice(0,20).map(s=>({sourceId:sourceId(s),kind:sourceKind(s),readableBySelector:['client-page','client-document'].includes(s.kind),...(s.kind==='client-page'&&publicSource(s.locator)?{url:publicSource(s.locator)}:{availableOnServer:true})}));
 const factView=f=>{const source=rawSources.find(s=>sourceId(s)&&(f.sourceId===s.id||s.locator===f.source)),exact=Boolean(source&&typeof source.text==='string'&&source.text.includes(f.claim));return{claim:text(f.claim,1000),sourceRef:source?sourceId(source):null,evidence:{exactSourceMatch:exact,sourceKind:sourceKind(source),...(source?{sourceSha256:createHash('sha256').update(String(source.text||'')).digest('hex')}:{})},verification:exact&&source.kind!=='author_statement'?'source-available-for-editor-review':'editor-review-required'};};
 const facts=(input.facts||[]).slice(0,20).map(factView);
 const questions=(claim.context?.questions||input.questions||[]).map(q=>({id:q.id,text:text(q.text,600),status:q.status,...(q.answer?{answer:text(q.answer,1000)}:{})}));
 return{schema:1,jobId:job.id,materialId:job.materialId,revision:job.revision,inputHash:job.inputHash,requestId:claim.requestId,owner:claim.owner,protocolVersion:job.protocolVersion===2?2:1,recipient:['S1','S2'].includes(job.recipient)?job.recipient:null,manifestRevision:Number.isSafeInteger(job.manifestRevision)?job.manifestRevision:null,budget:budgetView(job.budget||input.budget),goal:text(input.goal,160),brief:text(input.brief,4000),editingMode:input.editing_mode||'adapt',policyVersion:text(input.policyVersion,100),
  targets:(input.targets||job.targets||[]).map(t=>{const spec=targetSpec(t),key=targetKey(t);if(!spec)throw Error('unsupported target');return{channel:t.channel,format:t.format,kind:spec.kind,deliveryMode:t.delivery_mode,targetKey:key,entryName:targetEntryName({...job,targets:job.targets||input.targets},t),selectedOriginalIds:input.targetMedia?.[key]||null,facts:(input.targetFacts?.[key]||input.targetFacts?.[t.channel]||input.facts||[]).map(factView)};}),
  assets:(input.files||[]).map(f=>({mediaId:f.mediaId,sha256:f.sha256,bytes:f.bytes,mime:f.mime})),facts,sources,questions,answerRevision:claim.context?.answerRevision||job.answerRevision||0,answerHash:claim.context?.answerHash||job.answerHash||null,...(input.rework?{rework:{note:text(input.rework.note,1500),noteHash:input.rework.noteHash,targetKey:input.rework.targetKey,previousJobId:input.rework.previousJobId,entryId:input.rework.entryId,contentHash:input.rework.contentHash,previousResult:priorVariant(input),trust:'queue-feedback-content-untrusted'}}:{}),timing:input.timing?{mode:input.timing.mode,...(input.timing.at?{at:input.timing.at}:{})}:undefined,rightsStatus:input.rights?.status||'unknown',rightsManifestRevision:Number.isSafeInteger(input.rights?.manifestRevision)?input.rights.manifestRevision:null};
}
