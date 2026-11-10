// Приём фото из Telegram: закрытая временная загрузка, проверка байтов и декодирование.
// Токен бота остаётся на релее. Импорт оригинала не создаёт публичную ссылку и согласие.
import {mkdirSync,createWriteStream,createReadStream,openSync,readSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Readable,Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {dataPath,env} from '../lib/env.mjs';import {lock} from '../lib/files.mjs';
import {importMedia,libraryStatus,rows,blobPath} from './library.mjs';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),MAX=20*1024*1024;
const failure=code=>Object.assign(new Error(code),{code});
function assetType(file,allowVideo){
 const fd=openSync(file,'r');const b=Buffer.alloc(16);let n;try{n=readSync(fd,b,0,b.length,0);}finally{closeSync(fd);}
 if(n>=3&&b[0]===255&&b[1]===216&&b[2]===255)return '.jpg';
 if(n>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return '.png';
 if(n>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return '.webp';
 if(allowVideo&&n>=12&&b.toString('ascii',4,8)==='ftyp')return b.toString('ascii',8,12)==='qt  '?'.mov':'.mp4';
 throw failure('telegram_photo_type');
}
export {assetType as telegramAssetType};
export async function decodePhoto(file){
 try{
  const probe=await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_entries','stream=width,height','-of','json',file],{timeout:10000,maxBuffer:16384,windowsHide:true});
  const s=JSON.parse(probe.stdout).streams?.[0],width=s?.width,height=s?.height;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||width>8192||height>8192||width*height>40_000_000)throw Error('geometry');
  await exec('ffmpeg',['-v','error','-xerror','-protocol_whitelist','file,pipe','-threads','1','-i',file,'-frames:v','1','-f','null','-'],{timeout:15000,maxBuffer:16384,windowsHide:true});
  return {width,height};
 }catch{throw failure('telegram_photo_decode');}
}
export async function decodeVideo(file){
 try{
  const probe=await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','stream=width,height,codec_type:format=duration','-of','json',file],{timeout:10000,maxBuffer:16384,windowsHide:true});
  const info=JSON.parse(probe.stdout),s=info.streams?.find(s=>s.codec_type==='video'),duration=Number(info.format?.duration);
  if(!s||!Number.isSafeInteger(s.width)||!Number.isSafeInteger(s.height)||s.width<=0||s.height<=0||s.width>4096||s.height>4096||!Number.isFinite(duration)||duration<=0||duration>300)throw Error('geometry');
  await exec('ffmpeg',['-v','error','-xerror','-protocol_whitelist','file,pipe','-threads','1','-i',file,'-map','0:v:0','-map','0:a?','-f','null','-'],{timeout:60000,maxBuffer:16384,windowsHide:true});
  return{width:s.width,height:s.height,seconds:duration};
 }catch{throw failure('telegram_photo_decode');}
}
async function importTelegramAsset({fileId,bytes,material,source,variant},{fetcher=fetch,decode,space=libraryStatus,allowVideo=false}={}){
 if(typeof fileId!=='string'||! /^[A-Za-z0-9_-]{1,512}$/.test(fileId)||(bytes!==undefined&&(!Number.isSafeInteger(bytes)||bytes<=0||bytes>MAX)))throw failure('telegram_photo_limit');
 if(typeof variant!=='string'||! /^[A-Za-z0-9_-]{1,120}$/.test(variant))throw failure('telegram_photo_variant');
 if(typeof material!=='string'||!material||material.length>160||typeof source!=='string'||!source||source.length>240)throw failure('telegram_photo_metadata');
 const base=new URL(env('TG_RELAY_URL'));
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||!env('TG_RELAY_SECRET'))throw failure('telegram_photo_relay');
 const folder=dataPath('telegram-staging');mkdirSync(folder,{recursive:true,mode:0o700});
 const unlock=lock(path.join(folder,'import.lock'),240000);if(!unlock)throw failure('telegram_photo_busy');
 const file=path.join(folder,randomUUID()+'.part');
 try{
  const capacity=space(),reserve=1024**3,expected=bytes??MAX;
  if(!Number.isFinite(capacity.freeBytes)||capacity.freeBytes<reserve+2*expected||!Number.isSafeInteger(capacity.quotaBytes)||expected>capacity.quotaBytes||!Number.isFinite(capacity.bytes??0)||(capacity.bytes??0)+expected>capacity.quotaBytes)throw failure('telegram_photo_space');
  let res;try{res=await fetcher(base.href.replace(/\/+$/,'')+'/download/getFile',{method:'POST',headers:{'content-type':'application/json','x-relay-secret':env('TG_RELAY_SECRET')},body:JSON.stringify({file_id:fileId}),redirect:'error',signal:AbortSignal.timeout(60000)});}catch{throw failure('telegram_photo_network');}
  if(res.status!==200||!res.body){await res.body?.cancel();throw failure('telegram_photo_download');}
  const metadataSize=res.headers.get('x-telegram-file-size'),httpSize=res.headers.get('content-length'),declared=Number(metadataSize??httpSize);
  if(!Number.isSafeInteger(declared)||declared<=0||declared>MAX||(bytes!==undefined&&declared!==bytes)||(httpSize!==null&&Number(httpSize)!==declared)){await res.body.cancel();throw failure('telegram_photo_size');}
  bytes=declared;
  let received=0;
  try{await pipeline(Readable.fromWeb(res.body),new Transform({transform(chunk,encoding,cb){received+=chunk.length;if(received>bytes||received>MAX)return cb(failure('telegram_photo_size'));cb(null,chunk);}}),createWriteStream(file,{flags:'wx',mode:0o600}));}catch{throw failure('telegram_photo_incomplete');}
  if(received!==bytes)throw failure('telegram_photo_size');
  const extension=assetType(file,allowVideo);await (decode||(extension==='.mp4'||extension==='.mov'?decodeVideo:decodePhoto))(file);
  // Импорт требует расширение; только уже проверенный тип определяет это имя.
  const {renameSync}=await import('node:fs');const checked=file+extension;renameSync(file,checked);
  try{return await importMedia(checked,{material,source,variant,originalName:variant+extension,role:'original'});}finally{if(existsSync(checked))unlinkSync(checked);}
 }finally{if(existsSync(file))unlinkSync(file);unlock();}
}
export async function importTelegramPhoto(input,options){return importTelegramAsset(input,options);}
/** Общий договор приёмника; в первом проходе поддержаны только фотографии. */
export async function importTelegramFile({fileId,size,kind,material,source,variant},options){
 try{
  if(!['photo','document','video'].includes(kind))throw failure('telegram_photo_type');
  const row=await importTelegramAsset({fileId,bytes:size,material,source,variant},{...options,allowVideo:kind!=='photo'});
  return {...row,verified:true,readable:true};
 }catch(error){
  const codes={telegram_photo_limit:'TOO_LARGE',telegram_photo_space:'QUOTA',telegram_photo_network:'NETWORK',telegram_photo_download:'DOWNLOAD_UNAVAILABLE',telegram_photo_busy:'NETWORK',telegram_photo_type:'UNSUPPORTED',telegram_photo_relay:'IMPORT_UNAVAILABLE'};
  throw failure(codes[error?.code]||'INVALID_MEDIA');
 }
}
/** Привязка явно доставленного оператором оригинала: только закрытый blob этой задачи. */
export async function attachTelegramOriginal(app,{id,revision,fileUniqueId,mediaId},{decode}={}){
 const row=rows().find(r=>r.mediaId===mediaId&&r.material==='intake:'+id&&r.role==='original');
 if(!row)throw failure('telegram_photo_import');
 const file=blobPath(row),sha=createHash('sha256');let size=0;
 for await(const bytes of createReadStream(file)){size+=bytes.length;sha.update(bytes);}
 if(size!==row.bytes||sha.digest('hex')!==row.sha256)throw failure('telegram_photo_incomplete');
 const extension=assetType(file,true);await (decode||(extension==='.mp4'||extension==='.mov'?decodeVideo:decodePhoto))(file);
 return app.store.tx(s=>{
  const r=s.materials[id],f=r?.files.find(f=>f.fileUniqueId===fileUniqueId);
  if(!r||r.revision!==revision||!f||['archive','cancelled'].includes(r.mode))throw failure('telegram_photo_metadata');
  if(f.status==='verified'&&f.mediaId===mediaId)return{ok:true,duplicate:true,revision:r.revision};
  Object.assign(f,{status:'verified',mediaId:row.mediaId,sha256:row.sha256,bytes:row.bytes,mime:row.mime,errorCode:null,importMethod:'operator-ssh'});
  r.revision++;r.manifest_revision++;r.confirmedRevision=null;r.rights={status:'needs_clarification'};r.mode='draft';r.card.dirty=true;
  for(const j of Object.values(s.jobs))if(j.materialId===id&&j.revision!==r.revision)j.status='superseded';
  return{ok:true,revision:r.revision,publicationApproved:false};
 });
}
