// Постоянная медиатека: закрытые исходники, неизменяемые версии и единый mediaId.
// Импорт не публикует. Одобрение очереди разрешает выдачу только публикационной версии.
// Оригиналы не удаляются автоматически; переполнение квоты останавливает новый импорт.
import {createReadStream,createWriteStream,existsSync,mkdirSync,statSync,unlinkSync,renameSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {dataPath,env,wrongUser} from '../lib/env.mjs';import {lock,readJson,writeJson} from '../lib/files.mjs';
import {presignGet,uploadPrivate,downloadVerified} from './object-store.mjs';
import {probeVideo} from './probe.mjs';
const root=()=>dataPath('media-library');const index=()=>path.join(root(),'index.json');
const MIME={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.mp4':'video/mp4','.mov':'video/quicktime','.pdf':'application/pdf','.wav':'audio/wav','.mp3':'audio/mpeg','.srt':'text/plain','.txt':'text/plain','.svg':'image/svg+xml','.zip':'application/zip','.psd':'application/octet-stream','.ai':'application/octet-stream','.aep':'application/octet-stream','.prproj':'application/octet-stream','.blend':'application/octet-stream','.docx':'application/octet-stream'};
export const rows=()=>readJson(index(),{items:[]}).items;
export const canImportFile=file=>Boolean(MIME[path.extname(file).toLowerCase()])&&!path.basename(file).startsWith('.');
export function blobPath(row){if(!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('неверный хеш');return path.join(root(),'blobs',row.sha256);}
function save(items){writeJson(index(),{schema:1,updatedAt:new Date().toISOString(),items});}
function edit(id,change){const unlock=lock(path.join(root(),'registry.lock'));if(!unlock)throw Error('медиатека занята');try{const items=rows();const row=items.find(r=>r.mediaId===id);if(!row)throw Error('mediaId не найден');Object.assign(row,change);save(items);return row;}finally{unlock();}}
export async function importMedia(file,{material,role='original',variant='',parent=null,source,originalName,quotaBytes=Number(env('MEDIA_LOCAL_MAX_BYTES',String(512*1024*1024)))}={}) {
 if(wrongUser())throw Error(wrongUser());
 if(!Number.isSafeInteger(quotaBytes)||quotaBytes<=0)throw Error('неверная квота медиатеки');
 if(!material||!source||material.length>160||source.length>240)throw Error('нужны material и источник');
 if(!['original','publication','cover'].includes(role))throw Error('неизвестная роль файла');
 variant=variant||path.basename(originalName||file);if(variant.length>240)throw Error('слишком длинное имя версии');
 if(role==='original'&&parent)throw Error('оригинал не может ссылаться на публикационную версию');
 const ext=path.extname(file).toLowerCase(),mime=MIME[ext];if(!mime||path.basename(file).startsWith('.'))throw Error('такой исходник не импортируется; файлы окружения и ключи запрещены');
 if(role!=='original'&&!['.jpg','.jpeg','.png','.webp','.mp4','.mov'].includes(ext))throw Error('версия для площадки должна быть фото или видео');
 const unlock=lock(path.join(root(),'registry.lock'),60*60*1000);if(!unlock)throw Error('медиатека занята');
 let temp;
 try{
  const all=rows();const parentRow=all.find(r=>r.mediaId===parent&&r.material===material&&r.role==='original');if(role!=='original'&&!parentRow)throw Error('версия требует оригинал того же материала');
  const asset=role==='original'?variant:(parentRow.asset||parentRow.variant);
  const bytes=statSync(file).size;if(!bytes)throw Error('пустой файл');
  const unique=new Map(all.map(r=>[r.sha256,r.bytes]));const used=[...unique.values()].reduce((a,b)=>a+b,0);
  // Квота проверяется снова после хеширования: повторное содержимое место не занимает.
  if(bytes>quotaBytes)throw Error('файл превышает локальную квоту; подключите хранилище');
  mkdirSync(path.join(root(),'blobs'),{recursive:true,mode:0o700});temp=path.join(root(),`.import-${randomUUID()}`);
  let copied=0;const sha=createHash('sha256');await pipeline(createReadStream(file),new Transform({transform(c,e,cb){sha.update(c);copied+=c.length;cb(null,c);}}),createWriteStream(temp,{flags:'wx',mode:0o600}));
  if(copied!==bytes)throw Error('исходник изменился во время импорта; повторите после сохранения файла');
  const digest=sha.digest('hex');const group=all.filter(r=>r.material===material&&r.role===role&&r.variant===variant&&(r.asset||r.variant)===asset);
  const old=group.find(r=>r.sha256===digest&&r.parent===parent);if(old){unlinkSync(temp);temp=null;return old;}
  if(!unique.has(digest)&&used+bytes>quotaBytes)throw Error('локальная квота медиатеки исчерпана; исходник не удалён');
  const row={mediaId:'med_'+randomUUID().replace(/-/g,''),material,asset,role,variant,parent,version:group.length+1,supersedes:group.at(-1)?.mediaId||null,sha256:digest,bytes,extension:ext,mime,createdAt:new Date().toISOString(),source,originalName:path.basename(originalName||file),dimensions:['.mp4','.mov'].includes(ext)?probeVideo(file):null,delivery:null,replica:null,objectKey:`${role==='original'?'originals':'publications'}/${digest}${ext}`};
  const blob=blobPath(row);if(existsSync(blob))unlinkSync(temp);else renameSync(temp,blob);temp=null;
  all.push(row);save(all);return row;
 }finally{if(temp&&existsSync(temp))unlinkSync(temp);unlock();}
}
function config(){
 const c={endpoint:env('MEDIA_S3_ENDPOINT'),bucket:env('MEDIA_S3_BUCKET'),region:env('MEDIA_S3_REGION','ru-1'),accessKey:env('MEDIA_S3_ACCESS_KEY'),secretKey:env('MEDIA_S3_SECRET_KEY')};
 if(!c.endpoint||!c.bucket||!c.accessKey||!c.secretKey)throw Error('закрытое медиахранилище ещё не подключено');
 if(c.bucket===env('BACKUP_S3_BUCKET'))throw Error('бакет резервных копий нельзя использовать как медиатеку');
 const endpoint=new URL(c.endpoint);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error('S3 должен использовать чистый HTTPS-адрес');return c;
}
export async function replicate(id){const row=rows().find(r=>r.mediaId===id);if(!row)throw Error('mediaId не найден');const c=config();
 await uploadPrivate(c,row,blobPath(row));const verify=path.join(root(),`.verify-${randomUUID()}`);
 try{await downloadVerified(c,row,verify);}finally{if(existsSync(verify))unlinkSync(verify);}
 return edit(id,{replica:{status:'verified',at:new Date().toISOString()}});
}
export async function restoreBlob(id){const row=rows().find(r=>r.mediaId===id);if(!row)throw Error('mediaId не найден');if(existsSync(blobPath(row)))throw Error('локальный файл существует; восстановление поверх запрещено');mkdirSync(path.dirname(blobPath(row)),{recursive:true,mode:0o700});await downloadVerified(config(),row,blobPath(row));return row;}
export function adoptPublic(id,url,{confirmed=false}={}){
 const row=rows().find(r=>r.mediaId===id);if(!confirmed||!row||row.role==='original'||new URL(url).protocol!=='https:')throw Error('нужно отдельное подтверждение публичной версии, оригинал не выдаётся');
 return edit(id,{delivery:{kind:'explicit-public',url,confirmedAt:new Date().toISOString()}});
}
export async function resolveEntryMedia(entry,{head=fetch}={}){
 if(!(entry.media||[]).some(m=>m.mediaId||m.coverMediaId))return entry;
 if(!['approved','running'].includes(entry.status)||!entry.approval?.at)throw Error('медиа выдаётся только согласованной записи');
 const all=rows();
 const resolve=async id=>{
  const row=all.find(r=>r.mediaId===id);if(!row||row.material!==entry.material||row.role==='original')throw Error('медиа отсутствует, относится к другому материалу или является закрытым оригиналом');
  if(row.delivery?.kind==='explicit-public'){
   let r;try{r=await head(row.delivery.url,{method:'HEAD',signal:AbortSignal.timeout(20000)});}catch{throw Error('файл недоступен; выпуск остановлен, проверьте хранилище');}
   if(!r.ok)throw Error('файл недоступен; выпуск остановлен, проверьте хранилище');return row.delivery.url;
  }
  if(row.replica?.status!=='verified')throw Error('версия не проверена в S3; выполните синхронизацию медиатеки');
  // Семь суток от реальной попытки, а не от постановки в очередь. Ссылка не пишется
  // в очередь или журнал: адаптер получает временную копию записи только в памяти.
  const url=presignGet({...config(),key:row.objectKey});
  let r;try{r=await head(url,{method:'GET',headers:{range:'bytes=0-0'},signal:AbortSignal.timeout(20000)});await r.body?.cancel();}catch{throw Error('S3 недоступен; файл не выдан площадке');}
  if(!r.ok)throw Error('S3 отказал в доступе; файл не выдан площадке');return url;
 };
 const media=[];for(const m of entry.media||[]){const ready={...m};if(m.mediaId)ready.url=await resolve(m.mediaId);if(m.coverMediaId)ready.cover=await resolve(m.coverMediaId);media.push(ready);}return {...entry,media};
}
export function libraryStatus(){const all=rows(),unique=new Map(all.map(r=>[r.sha256,r.bytes]));return {records:all.length,originals:all.filter(r=>r.role==='original').length,versions:all.filter(r=>r.role!=='original').length,bytes:[...unique.values()].reduce((a,b)=>a+b,0),replicated:all.filter(r=>r.replica?.status==='verified').length,quotaBytes:Number(env('MEDIA_LOCAL_MAX_BYTES',String(512*1024*1024))),autoDelete:false};}
export async function auditLibrary(){let valid=0;const bad=[];for(const row of rows()){try{const sha=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(blobPath(row))){sha.update(chunk);bytes+=chunk.length;}if(bytes!==row.bytes||sha.digest('hex')!==row.sha256)throw Error();valid++;}catch{bad.push(row.mediaId);}}return {ok:!bad.length,verified:valid,failedIds:bad};}
export function mediaRefComplaints(entry){const all=rows(),bad=[];for(const m of entry.media||[])for(const [id,cover] of [[m.mediaId,false],[m.coverMediaId,true]]){if(!id)continue;const row=all.find(r=>r.mediaId===id);if(!row||row.material!==entry.material||row.role==='original')bad.push('готовность: в медиатеке нет доступной публикационной версии этого материала');else if((cover||m.type==='image')&&!row.mime.startsWith('image/')||(!cover&&m.type==='video'&&!row.mime.startsWith('video/')))bad.push('готовность: тип файла медиатеки не соответствует вложению');}return bad;}
