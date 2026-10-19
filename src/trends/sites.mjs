// Ежедневный снимок выбранных сайтов компаний для S4: доступность, заголовки и ссылки.
// Текст статей, авторы и комментарии не сохраняются. PDF не разбираются. Счётчики
// неизвестны; новая ссылка означает первое наблюдение, а не свежую публикацию.
// Список фиксирован отдельно от социальных каналов: VK не посещается даже при редиректе.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dataPath } from '../lib/env.mjs';
import { lock, readJson, writeJson } from '../lib/files.mjs';
import { mskDate } from '../lib/time.mjs';

function allowed(url) {
  return url.protocol === 'https:' && !url.username && !url.password && !/(^|\.)(vk\.(ru|com)|vkontakte\.ru)$/.test(url.hostname);
}
export async function inspectPage(target, fetcher = fetch) {
  const row={sourceId:target.sourceId,url:target.url,status:'unknown',title:null,published:null,metrics:null,textRead:false,candidates:[]};
  let url;
  try {url=new URL(target.url);} catch {return {...row,status:'invalid-url'};}
  if (!allowed(url)) return {...row,status:'blocked'};
  if (/\.pdf$/i.test(url.pathname)) return {...row,status:'unsupported-pdf'};
  try {
    const r=await fetcher(url.href,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'user-agent':'EcopolisSourceMonitor/1.0'}});
    row.httpStatus=r.status;
    if (r.status>=300 && r.status<400) return {...row,status:'redirect-not-followed'};
    if (!r.ok) return {...row,status:'http-error'};
    const type=r.headers.get('content-type') || '';
    if (type && !/text\/html|application\/xhtml/i.test(type)) return {...row,status:'unsupported-content'};
    // Размер ограничен до чтения целого ответа; сырой HTML в состояние не попадает.
    const reader=r.body?.getReader(); let html='', bytes=0;
    const decoder=new TextDecoder();
    if (reader) while(true) {
      const part=await reader.read(); if(part.done) break;
      bytes+=part.value.byteLength;
      if(bytes>2_000_000) {await reader.cancel(); return {...row,status:'too-large'};}
      html+=decoder.decode(part.value,{stream:true});
    }
    html+=decoder.decode();
    const title=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
    row.title=title.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim().slice(0,240) || null;
    if(!row.title) return {...row,status:'no-title'};
    const urls=new Set();
    for(const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      try {const link=new URL(match[1],url); link.search='';link.hash='';
        if(allowed(link) && link.origin===url.origin && /\/(articles?|news|blog|press)\//i.test(link.pathname) && !/\.(pdf|jpg|png)$/i.test(link.pathname)) urls.add(link.href);
      } catch { /* Не URL: пропускаем. */ }
      if(urls.size>=40) break;
    }
    return {...row,status:'metadata-only',candidates:[...urls]};
  } catch(e) {return {...row,status:'network-error',errorCode:e.cause?.code || e.name || 'network'};}
}

export async function collectSites({dir=dataPath('trends','sites'),targets,now=Date.now(),fetcher=fetch}={}) {
  const release=lock(path.join(dir,'daily.lock'),30*60_000);
  if(!release) return {busy:true};
  try {
    const date=mskDate(now); const file=path.join(dir,'daily',`${date}.json`);
    const prior=readJson(file);
    if(prior) return {...prior,duplicateDay:true};
    const previous=readJson(path.join(dir,'seen.json'),{}); const seen={...previous};
    const pages=[];
    for(const target of targets || []) {
      const row=await inspectPage(target,fetcher);
      row.checkedAt=new Date(now).toISOString();
      row.firstObservedUrls=[];
      for(const url of [row.url,...row.candidates]) {
        if(row.status!=='metadata-only') break;
        const key=createHash('sha256').update(url).digest('hex');
        if(!seen[key]) {seen[key]=date;row.firstObservedUrls.push(url);}
      }
      pages.push(row);
    }
    const result={date,at:new Date(now).toISOString(),mode:'selected-site-metadata',partialCoverage:true,metrics:null,articleTextRead:false,pages,
      limitations:['Нет чтения полного текста и PDF','Не проверены социальные каналы и VK','Первое наблюдение URL не равно дате публикации','Изменения заголовков не доказывают изменение содержания']};
    writeJson(file,result);writeJson(path.join(dir,'seen.json'),seen);writeJson(path.join(dir,'latest.json'),result);
    return result;
  } finally {release();}
}

if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  const targets=readJson(new URL('./sites.json',import.meta.url),[]);
  collectSites({targets}).then(r=>{
    const ok=(r.pages || []).filter(p=>p.status==='metadata-only').length;
    console.log(JSON.stringify({date:r.date,busy:Boolean(r.busy),duplicateDay:Boolean(r.duplicateDay),pages:r.pages?.length || 0,metadataAvailable:ok,partialCoverage:true}));
    if(!r.busy && !ok) process.exitCode=2;
  },()=>{console.error('Site metadata collection failed; no raw response logged');process.exitCode=2;});
}
