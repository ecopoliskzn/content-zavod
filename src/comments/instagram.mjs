// Комментарии Instagram: страницы публикаций, комментариев и ответов без имён в реестре.
// Пустая выдача при ненулевом счётчике и любой неполный проход отмечаются явно.
// Живые тексты остаются на российском сервере; диагностика содержит только счётчики.
import {ig,igUserId} from '../lib/ig.mjs';
import {dataDir,env} from '../lib/env.mjs';
import {sleep} from '../lib/http.mjs';
class ReadFailure extends Error{}

export async function readInstagramComments({userId=igUserId(),own=env('IG_USERNAME'),call=ig,pause=sleep,maxRequests=100}={}){
 if(call===ig&&!dataDir().startsWith('/opt/'))return {skipped:'живое чтение комментариев разрешено только на российском сервере'};
 if(!userId||(call===ig&&!env('IG_TOKEN')))return {skipped:'нет IG_USER_ID или IG_TOKEN'};
 const coverage={complete:false,mediaPages:0,media:0,commentPages:0,replyPages:0,visibleComments:0,countMismatchMedia:0,requests:0};
 const items=new Map(),seenMedia=new Set();
 const failed=error=>({error,coverage});
 const add=(c,m,parent='')=>{
  if(!c?.id||!c.text||own&&String(c.username||'').toLowerCase()===own.toLowerCase())return;
  items.set(String(c.id),{id:`instagram:${c.id}`,platform:'instagram',at:c.timestamp,text:String(c.text),link:m.permalink||'',post:String(m.id),...(parent?{parent:`instagram:${parent}`}:{})});
 };
 // Никогда не следуем paging.next: он может содержать токен или посторонний хост.
 async function pages(route,field,onPage){
  let after='';const seen=new Set();
  do{
   if(seen.has(after))throw new ReadFailure('Instagram: повтор курсора, сбор не завершён');seen.add(after);
   if(coverage.requests>=maxRequests)throw new ReadFailure('Instagram: достигнут предел запросов, сбор не завершён');
   if(coverage.requests)await pause(600);
   coverage.requests++;
   const r=await call(route+(after?'&after='+encodeURIComponent(after):''),{retries:0});
   if(r.kind!=='ok'||!Array.isArray(r.data?.data))throw new ReadFailure(`Instagram: сбор не завершён (${r.kind||'refused'}, HTTP ${Number(r.status)||0}, код ${Number(r.data?.error?.code)||0})`);
   coverage[field]++;await onPage(r.data.data);
   const paging=r.data.paging;
   if(paging?.next&&!paging.cursors?.after)throw new ReadFailure('Instagram: отсутствует курсор следующей страницы, сбор не завершён');
   after=paging?.next?String(paging.cursors.after):'';
  }while(after);
 }
 try{
  await pages(`${encodeURIComponent(userId)}/media?fields=id,permalink,comments_count,timestamp&limit=50`,'mediaPages',async media=>{
   for(const m of media){
    if(!m.id||seenMedia.has(String(m.id)))continue;seenMedia.add(String(m.id));coverage.media++;
    if(!Number.isFinite(Number(m.comments_count))||Number(m.comments_count)<0)throw new ReadFailure('Instagram: отсутствует счётчик комментариев, охват не подтверждён');
    if(!Number(m.comments_count))continue;
    const visible=new Set();
    await pages(`${encodeURIComponent(m.id)}/comments?fields=id,text,timestamp,username&limit=50`,'commentPages',async comments=>{
     for(const c of comments){
      if(!c.id)continue;visible.add(String(c.id));add(c,m);
      await pages(`${encodeURIComponent(c.id)}/replies?fields=id,text,timestamp,username&limit=50`,'replyPages',async replies=>{
       for(const reply of replies){if(reply.id)visible.add(String(reply.id));add(reply,m,c.id);}
      });
     }
    });
    coverage.visibleComments+=visible.size;
    if(visible.size<Number(m.comments_count))coverage.countMismatchMedia++;
   }
  });
 }catch(e){return failed(e instanceof ReadFailure?e.message:'Instagram: внутренняя ошибка, сбор не завершён');}
 if(coverage.countMismatchMedia)return failed('Instagram: счётчики и видимая выдача расходятся; отсутствие вопросов не подтверждено');
 coverage.complete=true;return {items:[...items.values()],coverage};
}
