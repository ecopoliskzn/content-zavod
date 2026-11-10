// Исходный снимок Instagram и Threads: только собственные материалы и числовые показатели.
// Не читает комментарии, переписку или списки людей; не публикует и не меняет расписание.
// Запросы передаются явно, поэтому тесты не используют боевые ключи. Частичный отказ
// сохраняется как ограничение, ноль отличается от отсутствующего измерения.

const VERSION='meta-baseline-1';
const DAY=86_400_000;
const METRICS={instagram:['views','reach','likes','comments','saved','shares'],threads:['views','likes','replies','reposts','quotes']};
const numeric=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const failure=r=>({kind:r?.kind||'invalid_response',httpStatus:Number(r?.status)||0,...(Number.isFinite(r?.data?.error?.code)?{apiCode:r.data.error.code}:{})});
const valueOf=m=>numeric(m?.values?.[0]?.value??m?.total_value?.value);

/** Сборщик не знает ключей и не сохраняет исходные ответы площадок. */
export async function collectBaseline({call,from,to,now=Date.now(),expectedUser='ecopolis_kzn',maxPages=50,maxRequests=300,delay=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  const start=Date.parse(from),end=Date.parse(to);
  if(typeof call!=='function'||!Number.isFinite(start)||!Number.isFinite(end)||start>=end||end>now)throw Error('Неверный период исходного снимка');
  const started=new Date().toISOString();
  const snapshot={version:VERSION,source:'Meta owner OAuth / own profiles only',collectedFrom:started,collectedTo:null,reportTimezone:'Europe/Moscow',requestedFrom:new Date(start).toISOString(),requestedTo:new Date(end).toISOString(),currentTo:new Date(now).toISOString(),requests:0,channels:[],limitations:['Метрики накопленные на момент замера, а не результат только за восемь недель.','Задержка готовности метрик неизвестна; отсутствие значения не равно нулю.','История Stories не собирается: отсутствие в списке не доказывает отсутствие историй.','Выдача собственных ответов Threads отдельно не запрашивается; полнота по ним не подтверждена.','Охваты материалов нельзя складывать в уникальный охват аккаунта.']};
  const query=async(platform,q)=>{
    if(snapshot.requests>=maxRequests)return {kind:'request_limit',status:0};
    if(snapshot.requests)await delay(500);
    snapshot.requests++;
    try{return await call(platform,q);}catch{return {kind:'network',status:0};}
  };
  for(const platform of ['instagram','threads']){
    const c={platform,source:platform==='instagram'?'Instagram Graph via existing server adapter (unversioned)':'Threads Graph v1.0',profile:null,status:'ok',inventoryComplete:false,metricsComplete:false,pages:0,sourceRows:0,duplicates:0,invalidRows:0,excludedOutsidePeriod:0,stopReason:null,errors:[],followers:{value:null,status:'not_measured',takenAt:null},list:[]};
    snapshot.channels.push(c);
    const me=await query(platform,platform==='instagram'?'me?fields=user_id,username,account_type,followers_count':'me?fields=id,username');
    const id=me.data?.user_id||me.data?.id;
    if(me.kind!=='ok'||!id){c.status='profile_unavailable';c.errors.push(failure(me));continue;}
    if(String(me.data.username).toLowerCase()!==expectedUser.toLowerCase()){c.status='wrong_profile';continue;}
    c.profile={id:String(id),username:expectedUser,...(platform==='instagram'?{accountType:String(me.data.account_type||'unknown')}:{})};
    let follower=numeric(me.data.followers_count),fr=me;
    if(platform==='threads'){
      fr=await query(platform,`${id}/threads_insights?metric=followers_count`);
      follower=fr.kind==='ok'?valueOf(fr.data?.data?.find(m=>m.name==='followers_count')):null;
    }
    c.followers={value:follower,status:follower!==null?'measured':fr.kind==='ok'?'missing':fr.kind,takenAt:new Date().toISOString(),definition:'Число подписчиков собственного профиля на момент запроса'};
    const fields=platform==='instagram'?'id,caption,timestamp,media_type,media_product_type,permalink,like_count,comments_count':'id,text,timestamp,media_type,permalink,is_reply';
    const edge=platform==='instagram'?'media':'threads';
    const seenIds=new Set(),seenCursors=new Set();
    let cursor='';
    do{
      if(c.pages>=maxPages){c.stopReason='page_limit';break;}
      if(seenCursors.has(cursor)){c.stopReason='repeated_cursor';break;}
      seenCursors.add(cursor);
      const q=new URLSearchParams({fields,limit:'100',...(cursor?{after:cursor}:{})});
      const r=await query(platform,`${id}/${edge}?${q}`);
      if(r.kind!=='ok'||!Array.isArray(r.data?.data)){c.errors.push(failure(r));c.stopReason=r.kind==='ok'?'invalid_page':r.kind;break;}
      c.pages++;
      for(const raw of r.data.data){
        c.sourceRows++;
        if(!raw.id||!Number.isFinite(Date.parse(raw.timestamp))){c.invalidRows++;continue;}
        const itemId=String(raw.id);
        if(seenIds.has(itemId)){c.duplicates++;continue;}
        seenIds.add(itemId);
        const at=Date.parse(raw.timestamp);
        if(at<start||at>=now){c.excludedOutsidePeriod++;continue;}
        const row={id:itemId,permalink:String(raw.permalink||''),publishedAt:new Date(at).toISOString(),format:String(raw.media_product_type||raw.media_type||'unknown'),ownText:String(raw.caption??raw.text??''),isOwnReply:typeof raw.is_reply==='boolean'?raw.is_reply:null,parentId:null,window:at<end?'baseline':'current',ageDaysAtCutoff:Number(((now-at)/DAY).toFixed(3)),metrics:{}};
        // Карусель учитывается один раз родительским объектом; children не запрашиваются.
        if(platform==='instagram')for(const [name,field] of [['likes','like_count'],['comments','comments_count']]){
          const n=numeric(raw[field]);if(n!==null)row.metrics[name]={value:n,status:'measured',source:'media_field',field,period:'snapshot',takenAt:new Date().toISOString()};
        }
        c.list.push(row);
      }
      if(!r.data.paging?.next){c.inventoryComplete=c.invalidRows===0;c.stopReason='end_of_feed';break;}
      // Никогда не следуем next URL: он может содержать маркер или чужой хост.
      cursor=r.data.paging?.cursors?.after;
      if(!cursor||typeof cursor!=='string'){c.stopReason='missing_cursor';break;}
    }while(true);
    c.uniqueIdsSeen=seenIds.size;
    c.list.sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt)||a.id.localeCompare(b.id));
    for(const row of c.list){
      const wanted=METRICS[platform].filter(n=>!row.metrics[n]);
      const r=await query(platform,`${row.id}/insights?metric=${wanted.join(',')}`);
      const data=r.kind==='ok'&&Array.isArray(r.data?.data)?r.data.data:[];
      const takenAt=new Date().toISOString();
      for(const name of wanted){
        const metric=data.find(m=>m.name===name),value=valueOf(metric);
        row.metrics[name]={value,status:value!==null?'measured':r.kind==='ok'?'missing':r.kind,source:'media_insights',period:metric?.period||'unknown',takenAt,...(r.kind!=='ok'?{failure:failure(r)}:{})};
      }
    }
    const dates=c.list.map(r=>r.publishedAt);
    c.actualFrom=dates[0]||null;c.actualTo=dates.at(-1)||null;
    c.metricsComplete=c.list.every(r=>METRICS[platform].every(n=>r.metrics[n]?.status==='measured'));
  }
  snapshot.collectedTo=new Date().toISOString();
  return snapshot;
}

const median=a=>{if(!a.length)return null;const v=[...a].sort((a,b)=>a-b),m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;};

/** Только воспроизводимые агрегаты. Ранжирование разновозрастных материалов не выполняется. */
export function summarizeBaseline(snapshot){
  const start=Date.parse(snapshot.requestedFrom),end=Date.parse(snapshot.requestedTo);
  return {version:VERSION,sourceCollectedFrom:snapshot.collectedFrom,sourceCollectedTo:snapshot.collectedTo,requestedFrom:snapshot.requestedFrom,requestedTo:snapshot.requestedTo,timezone:snapshot.reportTimezone,rankingPerformed:false,rankingReason:'Накопленные значения материалов разного возраста нельзя ранжировать как результат одинакового периода.',channels:snapshot.channels.map(c=>{
    const baseline=c.list.filter(r=>r.window==='baseline'),current=c.list.filter(r=>r.window==='current');
    const weeks=[];for(let t=start;t<end;t+=7*DAY){const until=Math.min(t+7*DAY,end);weeks.push({from:new Date(t).toISOString(),to:new Date(until).toISOString(),count:baseline.filter(r=>Date.parse(r.publishedAt)>=t&&Date.parse(r.publishedAt)<until).length});}
    const groups=new Map();for(const row of baseline){const ageWeek=Math.floor(row.ageDaysAtCutoff/7),key=`${row.format}:${ageWeek}`;if(!groups.has(key))groups.set(key,{format:row.format,ageWeek,rows:[]});groups.get(key).rows.push(row);}
    return {platform:c.platform,profile:c.profile,status:c.status,inventoryComplete:c.inventoryComplete,stopReason:c.stopReason,pages:c.pages,sourceRows:c.sourceRows,uniqueIdsSeen:c.uniqueIdsSeen||0,duplicates:c.duplicates,invalidRows:c.invalidRows,followers:c.followers,baselineCount:baseline.length,currentCount:current.length,latestPublication:c.list.at(-1)?.publishedAt||null,byFormat:Object.fromEntries([...new Set(baseline.map(r=>r.format))].map(f=>[f,baseline.filter(r=>r.format===f).length])),weeks,coverage:Object.fromEntries(METRICS[c.platform].map(name=>[name,{measured:c.list.filter(r=>r.metrics[name]?.status==='measured').length,total:c.list.length}])),cumulativeMediansByFormatAndAgeWeek:[...groups.values()].map(g=>({format:g.format,ageWeek:g.ageWeek,count:g.rows.length,medians:Object.fromEntries(METRICS[c.platform].map(name=>[name,median(g.rows.map(r=>r.metrics[name]?.value).filter(Number.isFinite))]))})),errors:c.errors};})};
}
