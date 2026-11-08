// Одобренное intake-видео загружается закрытым, без второго расписания YouTube.
// Сессия и номер сохраняются ДО следующего эффекта: потерянный ACK сверяется,
// а не превращается в новый videos.insert. Открывает ролик только штатный runner.
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';import path from 'node:path';
import {dataPath} from '../lib/env.mjs';import {intakeLock} from '../bot/media-intake-store.mjs';
import {get,patch} from '../queue/store.mjs';import {contentHash} from '../queue/format.mjs';
import {stopState,isHeld,isRestored} from '../queue/switch.mjs';
import {rows,blobPath} from '../media/library.mjs';import {describe} from './describe.mjs';
import * as youtube from '../channels/youtube.mjs';import {updateSnippet,setThumbnail} from './youtube-tools.mjs';
import {instance,publicationBlockers} from '../bot/media-intake-runtime.mjs';
import {verifyIntakeResult} from '../bot/media-intake-delivery.mjs';
import {targetEntryName,targetKey} from '../bot/media-intake-targets.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const managed=e=>e?.channel==='youtube'&&['video','short'].includes(e.kind)&&/^mi-([a-f0-9]{16})-([1-9]\d*)(?:-[a-f0-9]{6})?$/.test(e.name||'')&&e.material===`intake:${e.name.slice(3,19)}`;
const hold=(reason,status='blocked')=>({ok:false,ready:false,status,reason});
const videoId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{11}$/.test(id);
const stopped=()=>stopState().stopped||isHeld()||isRestored();
function nativeCurrent(e){
 if(publicationBlockers(e).length)return false;
 const app=instance(),jobs=app.jobs(),matches=jobs.filter(j=>j.status==='completed'&&j.artifactsVerified&&j.targets.some(t=>t.channel==='youtube'&&targetEntryName(j,t)===e.name&&app.isCurrentTarget(j.id,targetKey(t))));
 return matches.length===1&&verifyIntakeResult(matches[0].result,matches[0]);
}
function assets(e,catalog,localPath){
 if(e.media?.length!==1||e.media[0].type!=='video'||!e.media[0].mediaId||e.media[0].url||e.media[0].cover)throw Error('media');
 const all=catalog(),read=(id,cover=false)=>{
  const r=all.find(r=>r.mediaId===id);
  if(!r||r.material!==e.material||!(cover?['publication','cover']:['publication']).includes(r.role)||!(cover?['image/jpeg','image/png'].includes(r.mime):r.mime?.startsWith('video/'))||!r.parent)throw Error('media');
  const file=localPath(r),bytes=readFileSync(file);if(!bytes.length||bytes.length!==r.bytes||sha(bytes)!==r.sha256)throw Error('bytes');
  if(cover&&bytes.length>2*1024*1024)throw Error('cover_size');return{...r,file,data:bytes};
 };
 const video=read(e.media[0].mediaId),cover=e.media[0].coverMediaId?read(e.media[0].coverMediaId,true):null;
 if(cover&&cover.parent!==video.parent)throw Error('cover_parent');return{video,cover};
}
function save(file,r){
 const temp=file+'.tmp';writeFileSync(temp,JSON.stringify(r),{mode:0o600});const fd=openSync(temp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,file);
}
function sessionUrl(value){const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='www.googleapis.com'||u.port||u.username||u.password||u.hash||u.pathname!=='/upload/youtube/v3/videos')throw Error('session');return u.href;}
/** Низкоуровневый resumable-клиент. Session URI возвращается только закрытому журналу. */
export function createIntakeYoutubeTransport({fetchImpl=fetch,token=youtube.accessToken}={}){
 const call=async(url,init)=>{const t=await token();if(t.kind!=='ok')throw Object.assign(Error('youtube_auth'),{notSent:true});return fetchImpl(url,{...init,headers:{...init.headers,authorization:`Bearer ${t.token}`},redirect:'error',signal:AbortSignal.timeout(init.method==='POST'?60000:30*60*1000)});};
 const result=async r=>{
  if(r.status===308){const range=r.headers.get('range'),m=range?.match(/^bytes=0-(\d+)$/);if(range&&!m)throw Error('range');return{offset:m?Number(m[1])+1:0};}
  if(!r.ok)return{unknown:true,reason:r.status===404?'session_expired':'upload_response'};
  const data=await r.json();return videoId(data.id)?{id:data.id}:{unknown:true,reason:'upload_id_missing'};
 };
 return{
  async start({snippet,mime,size}){let r;try{r=await call('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',{method:'POST',headers:{'content-type':'application/json; charset=utf-8','x-upload-content-length':String(size),'x-upload-content-type':mime},body:JSON.stringify({snippet,status:{privacyStatus:'private',selfDeclaredMadeForKids:false}})});}catch(e){if(e.notSent)return{notStarted:true,reason:'youtube_auth'};throw e;}if(!r.ok){if(r.status>=400&&r.status<500)return{notStarted:true,reason:'session_refused'};throw Error('session_start');}return{session:sessionUrl(r.headers.get('location'))};},
  async probe(session,size){return result(await call(sessionUrl(session),{method:'PUT',headers:{'content-length':'0','content-range':`bytes */${size}`}}));},
  async send(session,data,offset,mime){return result(await call(sessionUrl(session),{method:'PUT',headers:{'content-length':String(data.length-offset),'content-type':mime,'content-range':`bytes ${offset}-${data.length-1}/${data.length}`},body:data.subarray(offset)}));},
 };
}
/**
 * S0 вызывает для сырой approved/running записи ДО resolveEntryMedia/publish.
 * ready=true означает только private upload + актуальные сведения + queue extra.
 * Никаких публикации/планирования/LLM. Остальные площадки продолжает штатный runner.
 */
export async function preflightIntakeYoutube(entry,{
 dir=dataPath('youtube-intake-preflight'),getEntry=get,patchEntry=patch,
 isCurrent=nativeCurrent,halted=stopped,catalog=rows,localPath=blobPath,
 describe:compose=describe,transport=createIntakeYoutubeTransport(),
 api={status:youtube.status,setSchedule:youtube.setSchedule,updateSnippet,setThumbnail},
}={}){
 if(!managed(entry))return{ok:true,ready:false,status:'unmanaged'};
 const snapshot=structuredClone(entry),hash=entry.contentHash;
 const fresh=()=>{const e=getEntry(entry.id);return e&&managed(e)&&e.contentHash===hash&&contentHash(e)===hash&&['approved','running'].includes(e.status)&&e.approval?.at&&Number.isFinite(Date.parse(e.approval.at))&&e.approval.cardHash===hash&&e.approval.card?.messageId&&e.approval.at===snapshot.approval?.at&&e.approval.actionToken===snapshot.approval?.actionToken&&!halted()&&isCurrent(e)===true?e:null;};
 let initial;try{initial=fresh();if(!initial)return hold('approval_or_currentness');}catch{return hold('currentness_unavailable');}
 let media;try{media=assets(initial,catalog,localPath);}catch{return hold('publication_bytes');}
 const entryKey=sha(String(entry.id)).slice(0,32);mkdirSync(dir,{recursive:true,mode:0o700});
 const unlock=intakeLock(path.join(dir,entryKey+'.lock'));if(!unlock)return hold('preflight_busy');
 const file=path.join(dir,`${entryKey}-${media.video.sha256}.json`);let r;
 const still=()=>{const e=fresh();if(!e)return null;const m=assets(e,catalog,localPath);return m.video.mediaId===media.video.mediaId&&m.video.sha256===media.video.sha256&&(m.cover?.sha256||'')===(media.cover?.sha256||'')?e:null;};
 try{
  if(existsSync(file)){try{r=JSON.parse(readFileSync(file,'utf8'));}catch{return hold('receipt_corrupt','unknown');}}
  if(r&&(r.schema!==1||r.entryId!==entry.id||r.material!==entry.material||r.mediaId!==media.video.mediaId||r.sha256!==media.video.sha256||r.bytes!==media.video.bytes))return hold('receipt_binding','unknown');
  if(initial.extra?.youtubeId&&initial.extra.youtubeId!==r?.videoId)return hold('youtube_id_without_matching_receipt','unknown');
  if(!r){r={schema:1,entryId:entry.id,material:entry.material,mediaId:media.video.mediaId,sha256:media.video.sha256,bytes:media.video.bytes,phase:'prepared',initialHash:hash};save(file,r);}
  if(!r.videoId&&!r.session){
   if(r.phase!=='prepared')return hold('session_start_unknown','unknown');
   if(!still())return hold('approval_changed');
   const snippet={title:initial.title,description:compose(initial),tags:initial.tags||[],categoryId:'22',defaultLanguage:'ru',defaultAudioLanguage:'ru'};
   r.phase='starting';save(file,r);
   const started=await transport.start({snippet,status:{privacyStatus:'private',selfDeclaredMadeForKids:false},mime:media.video.mime,size:media.video.bytes});
   if(started.notStarted){r.phase='prepared';save(file,r);return hold(started.reason||'session_not_started','pending');}
   r.session=sessionUrl(started.session);r.phase='session';save(file,r);
  }else if(!r.videoId){
   if(!still())return hold('approval_changed');
   const reconciled=await transport.probe(r.session,r.bytes);
   if(reconciled.id){if(!videoId(reconciled.id))return hold('invalid_video_id','unknown');r.videoId=reconciled.id;r.phase='uploaded';save(file,r);}
   else if(reconciled.unknown)return hold(reconciled.reason||'upload_unknown','unknown');
   else{if(!Number.isSafeInteger(reconciled.offset)||reconciled.offset<0||reconciled.offset>=r.bytes)return hold('upload_range_unknown','unknown');r.offset=reconciled.offset;r.phase='session';save(file,r);}
  }
  if(!r.videoId){
   if(!still())return hold('approval_changed');const offset=r.offset||0;
   if(!Number.isSafeInteger(offset)||offset<0||offset>=r.bytes)return hold('upload_range_unknown','unknown');
   r.phase='sending';save(file,r);
   const sent=await transport.send(r.session,media.video.data,offset,media.video.mime);
   if(!sent.id){if(sent.offset!==undefined){if(!Number.isSafeInteger(sent.offset)||sent.offset<0||sent.offset>=r.bytes)return hold('upload_range_unknown','unknown');r.offset=sent.offset;r.phase='session';save(file,r);}return hold(sent.reason||'upload_incomplete',sent.unknown?'unknown':'pending');}
   if(!videoId(sent.id))return hold('invalid_video_id','unknown');r.videoId=sent.id;r.phase='uploaded';save(file,r);
  }
  if(!videoId(r.videoId))return hold('receipt_video_id','unknown');
  let e=still();if(!e)return hold('approval_changed');
  let live=await api.status(r.videoId);if(live.kind!=='ok')return hold('youtube_status','pending');
  if(live.raw?.id!==r.videoId)return hold('youtube_status_identity');
  if(live.privacy==='public'){
   const actual=live.raw.snippet,want={title:e.title,description:compose(e),tags:e.tags||[]};
   if(r.phase==='ready'&&r.contentHash===hash&&e.extra?.youtubeId===r.videoId&&e.extra.youtubeHash===hash&&(r.coverHash||'')===(media.cover?.sha256||'')&&r.metadataHash===sha(JSON.stringify(want))&&actual?.title===want.title&&actual?.description===want.description&&JSON.stringify(actual.tags||[])===JSON.stringify(want.tags)&&!live.publishAt&&still())return{ok:true,ready:true,status:'already_public',entry:getEntry(entry.id)};
   return hold('youtube_not_private');
  }
  if(live.privacy!=='private')return hold('youtube_not_private');
  if(live.publishAt){if(!still())return hold('approval_changed');const off=await api.setSchedule(live.raw,'');if(!off.ok)return hold('youtube_schedule_not_removed');}
  if(['failed','rejected'].includes(live.upload))return hold('youtube_processing_failed');
  e=still();if(!e)return hold('approval_changed');
  const snippet={title:e.title,description:compose(e),tags:e.tags||[]},metadataHash=sha(JSON.stringify(snippet));
  if(r.metadataHash!==metadataHash){r.phase='updating';save(file,r);const updated=await api.updateSnippet(r.videoId,snippet);if(!updated.ok)return hold('youtube_metadata','pending');
   if(!still())return hold('approval_changed');live=await api.status(r.videoId);
   const actual=live.raw?.snippet;if(live.kind!=='ok'||live.raw?.id!==r.videoId||live.privacy!=='private'||live.publishAt||actual?.title!==snippet.title||actual?.description!==snippet.description||JSON.stringify(actual.tags||[])!==JSON.stringify(snippet.tags))return hold('youtube_metadata_unconfirmed','unknown');
   r.metadataHash=metadataHash;save(file,r);
  }else{const actual=live.raw?.snippet;if(actual?.title!==snippet.title||actual?.description!==snippet.description||JSON.stringify(actual.tags||[])!==JSON.stringify(snippet.tags))return hold('youtube_metadata_drift');}
  if(r.coverHash&&!media.cover)return hold('youtube_cover_removed');
  if(media.cover&&r.coverHash!==media.cover.sha256){if(!still())return hold('approval_changed');const coverFile=path.join(dir,`${entryKey}-cover${media.cover.mime==='image/png'?'.png':'.jpg'}`);let cover;
   try{writeFileSync(coverFile,media.cover.data,{mode:0o600});cover=await api.setThumbnail(r.videoId,coverFile);}finally{try{unlinkSync(coverFile);}catch{}}
   if(!cover?.ok)return hold('youtube_cover','pending');r.coverHash=media.cover.sha256;save(file,r);
  }
  e=still();if(!e)return hold('approval_changed');
  if(e.extra?.youtubeId!==r.videoId||e.extra.youtubeHash!==hash||e.extra.youtubePublishAt!=='')await patchEntry(e.id,{extra:{...e.extra,youtubeId:r.videoId,youtubeHash:hash,youtubePublishAt:''}},'intake YouTube preflight',{contentHash:hash,actionToken:e.approval.actionToken,card:e.approval.card.messageId});
  if(!still())return hold('approval_changed');if(r.phase!=='ready'||r.contentHash!==hash){r.phase='ready';r.contentHash=hash;save(file,r);}
  return{ok:true,ready:true,status:'ready',entry:getEntry(entry.id)};
 }catch{return hold('preflight_interrupted','unknown');}finally{unlock();}
}
