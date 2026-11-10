// Опись собственных Threads из API, затем все страницы conversation (включая вложенные
// ответы). Журнал завода не ограничивает охват. Имена нужны только для фильтра своих
// реплик и не сохраняются; частичный/пустой охват не выдаётся за отсутствие вопросов.
import {dataDir,env} from '../lib/env.mjs';import {request,sleep} from '../lib/http.mjs';
const api=route=>request('https://graph.threads.net/v1.0/'+route,{headers:{authorization:'Bearer '+env('THREADS_TOKEN')},retries:0,timeoutMs:25000});
export async function readThreadsComments({userId=env('THREADS_USER_ID'),own=env('THREADS_USERNAME'),call=api,pause=sleep,maxRequests=200}={}){
 if(call===api&&!dataDir().startsWith('/opt/'))return{skipped:'живое чтение комментариев разрешено только на российском сервере'};
 if(!userId||call===api&&!env('THREADS_TOKEN'))return{skipped:'нет THREADS_USER_ID или THREADS_TOKEN'};
 const coverage={complete:false,inventory:'own-account-api',postPages:0,posts:0,replyPages:0,requests:0,visibleReplies:0};const items=new Map(),posts=new Map();
 const fail=message=>({error:message,coverage});
 async function pages(route,field,consume){let after='';const seen=new Set();do{
  if(seen.has(after))throw Error('Threads: повтор курсора, охват не завершён');seen.add(after);
  if(coverage.requests>=maxRequests)throw Error('Threads: предел запросов, охват не завершён');
  if(coverage.requests)await pause(1500);coverage.requests++;
  let r;try{r=await call(route+(after?'&after='+encodeURIComponent(after):''));}catch{throw Error('Threads: сеть недоступна, охват не завершён');}
  if(r.kind!=='ok'||!Array.isArray(r.data?.data))throw Error(`Threads: охват не завершён (${['ok','network','refused'].includes(r.kind)?r.kind:'invalid'}, HTTP ${Number(r.status)||0}, код ${Number(r.data?.error?.code)||0}, подкод ${Number(r.data?.error?.error_subcode)||0})`);
  coverage[field]++;consume(r.data.data);const p=r.data.paging;
  if(p?.next&&!p.cursors?.after)throw Error('Threads: нет курсора следующей страницы');after=p?.next?String(p.cursors.after):'';
 }while(after);}
 try{
  // При отсутствии имени настроенного аккаунта выясняем его один раз, без сохранения.
  if(!own){coverage.requests++;const who=await call('me?fields=id,username');if(who.kind!=='ok'||String(who.data?.id)!==String(userId)||!who.data?.username)return fail('Threads: собственный профиль не подтверждён');own=who.data.username;}
  await pages(`${encodeURIComponent(userId)}/threads?fields=id,permalink,timestamp&limit=100`,'postPages',rows=>{for(const row of rows)if(row.id)posts.set(String(row.id),{id:String(row.id),link:row.permalink||''});});coverage.posts=posts.size;
  if(!posts.size)return fail('Threads: API вернул пустую опись; отсутствие вопросов не подтверждено');
  for(const post of posts.values())await pages(`${encodeURIComponent(post.id)}/conversation?fields=id,text,timestamp,username,permalink&limit=100`,'replyPages',rows=>{for(const c of rows){
   if(!c.id||!c.text)continue;coverage.visibleReplies++;
   if(String(c.username||'').replace(/^@/,'').toLowerCase()===String(own).replace(/^@/,'').toLowerCase())continue;
   if(!Number.isFinite(Date.parse(c.timestamp)))throw Error('Threads: отсутствует время комментария');
   items.set(String(c.id),{id:'threads:'+c.id,platform:'threads',at:c.timestamp,text:String(c.text),link:c.permalink||post.link,post:post.id});
  }});
 }catch(e){return fail(/^Threads:/.test(e.message)?e.message:'Threads: внутренняя ошибка, охват не завершён');}
 coverage.complete=true;return{items:[...items.values()],coverage};
}
