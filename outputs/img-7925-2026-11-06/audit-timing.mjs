// Снимок двух собственных записей до/после исправления сроков без изменения очереди.
// Фиксирует только публикационный комплект и режим времени, не читает данные людей.
import fs from 'node:fs';import crypto from 'node:crypto';
import {env} from '../../src/lib/env.mjs';import {request} from '../../src/lib/http.mjs';
const phase=process.argv[2]||'pre-install';if(!['before','pre-install','current','after'].includes(phase))throw Error('фаза before/pre-install/current/after');
const records=[];
for(const channel of ['youtube','instagram']){
 const r=await request(env('QUEUE_API_BASE').replace(/\/+$/,'')+'/admin/queue',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+env('ADMIN_API_TOKEN')},body:JSON.stringify({cmd:'show',args:{ref:'hibiny-1-ecm-7925',channel},actor:'оператор'}),timeoutMs:60000});
 if(r.kind!=='ok'||r.data?.code!==0)throw Error('не удалось прочитать '+channel);
 const e=r.data.data;const payload={};for(const k of ['channel','kind','name','material','title','text','posts','media','hashtags','goSlug','goLabel','series','seeAlso','facts','ask'])if(e[k]!==undefined)payload[k]=e[k];
 const payloadSha256=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 records.push({id:e.id,channel:e.channel,status:e.status,date:e.date,time:e.time,timing:e.timing||null,contentHash:e.contentHash||null,payloadSha256,payload,approvalAt:e.approval?.at||null,hasUploadedYoutubeId:Boolean(e.extra?.youtubeId),youtubeId:e.extra?.youtubeId||null,youtubePublishAt:e.extra?.youtubePublishAt||null,note:e.note||null});
}
const out={captured:new Date().toISOString(),phase,records};
if(phase==='after'){
 const baseline=fs.existsSync('outputs/img-7925-2026-11-06/timing-audit-pre-install.json')?'timing-audit-pre-install.json':'timing-audit-before.json';
 const before=JSON.parse(fs.readFileSync('outputs/img-7925-2026-11-06/'+baseline,'utf8'));
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 for(const r of records){const p=before.records.find(v=>v.id===r.id);if(!p||p.payloadSha256!==r.payloadSha256||p.contentHash!==r.contentHash)throw Error('Изменено содержимое/hash '+r.channel);const approvedSinceSnapshot=p.status==='review'&&r.approvalAt&&['approved','failed','running','published'].includes(r.status);if(p.status!==r.status&&!approvedSinceSnapshot)throw Error('Необъяснённый переход статуса '+r.channel);if(r.timing?.mode!=='after-approval')throw Error('Неверный timing '+r.channel);}
 for(const r of records)if(r.date!==today)throw Error('Сохранён будущий/прошедший слот '+r.channel+': '+r.date);
 out.validation='Состав и contentHash сохранены; изменения статуса после review подтверждены штатным approvalAt; обе записи after-approval';
}
fs.writeFileSync(`outputs/img-7925-2026-11-06/timing-audit-${phase}.json`,JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({...out,records:records.map(({payload,...r})=>r)},null,2));
