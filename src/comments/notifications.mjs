// Надёжная очередь сводок отдельно от found/new. Уже сохранённый комментарий не теряет
// уведомление. Intent пишется до Telegram; неизвестный ACK удерживается без слепого дубля.
import {existsSync,readFileSync,mkdirSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync} from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {dataPath,env} from '../lib/env.mjs';import {tg,h} from '../lib/telegram.mjs';import {intakeLock} from '../bot/media-intake-store.mjs';
const title={threads:'Threads',youtube:'YouTube',vk:'ВКонтакте',rutube:'Rutube',instagram:'Instagram'};
function persist(file,value){mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});const fd=openSync(tmp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);}
const excerpt=text=>String(text||'').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu,'[контакт скрыт]').replace(/\+?\d[\d ()-]{8,}\d/gu,'[номер скрыт]').replace(/[?&](?:access_token|token|secret|signature|key)=[^\s]+/giu,'[секрет скрыт]').replace(/\s+/g,' ').slice(0,160);
async function telegram(text){if(!env('TG_GROUP_ID')||!env('TG_TOPIC_COMMENTS'))return{kind:'refused',status:0};const r=await tg('sendMessage',{chat_id:env('TG_GROUP_ID'),message_thread_id:Number(env('TG_TOPIC_COMMENTS')),text,parse_mode:'HTML',link_preview_options:{is_disabled:true}},{retries:0,timeoutMs:25000});return{kind:r.kind,status:r.status,messageId:r.result?.message_id};}
export async function flushCommentNotifications(rows,{file=dataPath('comments-notifications.json'),deliver=telegram,only=[]}={}){
 const unlock=intakeLock(file+'.lock');if(!unlock)return{busy:true,sent:0};
 try{
  // Повреждённый журнал — отказ, никогда не новая пустая очередь (иначе были бы дубли).
  const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{schema:1,batches:{}};
  if(state.schema!==1||!state.batches||Array.isArray(state.batches))throw Error('notification state invalid');
  for(const b of Object.values(state.batches))if(b.status==='sending')b.status='unknown';
  const sourceMap=new Map(rows.map(c=>[c.id,c])),known=new Set(Object.values(state.batches).flatMap(b=>b.commentIds)),available=rows.filter(c=>c.status==='new'&&(!only.length||only.includes(c.platform))),map=new Map(available.map(c=>[c.id,c]));
  const fresh=available.filter(c=>!known.has(c.id));
  for(const platform of new Set(fresh.map(c=>c.platform))){const same=fresh.filter(c=>c.platform===platform);for(let i=0;i<same.length;i+=12){const ids=same.slice(i,i+12).map(c=>c.id),id=createHash('sha256').update(ids.join('\n')).digest('hex');state.batches[id]={id,platform,commentIds:ids,status:'pending',attempts:0};}}persist(file,state);
  const out={sent:0,failed:0,unknown:0,messageIds:[]};
  for(const batch of Object.values(state.batches)){
   if(only.length&&!batch.commentIds.some(id=>only.includes(sourceMap.get(id)?.platform)))continue;
   if(batch.status==='unknown'){out.unknown++;continue;}if(batch.status!=='pending')continue;
   const current=batch.commentIds.map(id=>map.get(id)).filter(Boolean);if(!current.length){batch.status='cancelled';persist(file,state);continue;}
   const counts={};for(const c of current)counts[c.platform]=(counts[c.platform]||0)+1;
   const text=`💬 <b>Новые комментарии: ${current.length}</b>\n${Object.entries(counts).map(([p,n])=>`${title[p]||p} ${n}`).join(' · ')}\n\n`+current.map(c=>`· <a href="${h(c.link)}">${h(title[c.platform]||c.platform)}</a>: «${h(excerpt(c.text))}»`).join('\n')+'\n\n<i>Ответы готовит оператор; публикации ответов требуют отдельного согласования.</i>';
   batch.status='sending';batch.attempts++;batch.attemptAt=new Date().toISOString();persist(file,state);
   let result;try{result=await deliver(text);}catch{result={kind:'network'};}
   if(result.kind==='ok'&&Number.isSafeInteger(result.messageId)&&result.messageId>0){batch.status='sent';batch.messageId=result.messageId;batch.sentAt=new Date().toISOString();out.sent++;out.messageIds.push(result.messageId);}
   else if(result.kind==='refused'){batch.status='pending';batch.lastHttp=Number(result.status)||0;out.failed++;}
   else{batch.status='unknown';out.unknown++;}persist(file,state);
  }return out;
 }finally{unlock();}
}
