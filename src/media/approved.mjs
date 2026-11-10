// Новый файл публикационной версии выдаётся по действующему согласию очереди.
// Ни S3, ни ручное adoptPublic не нужны. Оригиналы/backup и снятое согласие дают 404.
import {createHash} from 'node:crypto';import {openSync,readSync,closeSync,statSync,realpathSync,createReadStream} from 'node:fs';import path from 'node:path';
import {rows,blobPath} from './library.mjs';import {get} from '../queue/store.mjs';import {contentHash} from '../queue/format.mjs';import {env,dataPath} from '../lib/env.mjs';
import {publicationBlockers} from '../bot/media-intake-runtime.mjs';
const extMime={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.mp4':'video/mp4'};
function authorized(entry,id){return Boolean(entry&&['approved','running','handed','published'].includes(entry.status)&&entry.approval?.at&&entry.contentHash===contentHash(entry)&&(!entry.approval.cardHash||entry.approval.cardHash===entry.contentHash)&&publicationBlockers(entry).length===0&&(entry.media||[]).some(m=>m.mediaId===id||m.coverMediaId===id));}
function verifiedFile(row){
 if(!row||!['publication','cover'].includes(row.role)||!extMime[row.extension]||row.mime!==extMime[row.extension])throw Error('not a publication version');
 const root=realpathSync(dataPath('media-library','blobs')),file=realpathSync(blobPath(row));if(!file.startsWith(root+path.sep))throw Error('outside media library');
 const info=statSync(file),max=row.mime==='video/mp4'?300*1024*1024:10*1024*1024;if(!info.isFile()||info.size!==row.bytes||info.size<=0||info.size>max)throw Error('publication size');
 const fd=openSync(file,'r'),hash=createHash('sha256'),chunk=Buffer.alloc(1024*1024);try{let size;while((size=readSync(fd,chunk,0,chunk.length,null))>0)hash.update(chunk.subarray(0,size));}finally{closeSync(fd);}if(hash.digest('hex')!==row.sha256)throw Error('publication hash');return file;
}
export function approvedMediaUrl(entry,id,{getEntry=get,all=rows(),base=env('PUBLIC_BASE_URL')}={}){
 const current=getEntry(entry.id),row=all.find(r=>r.mediaId===id);
 if(!authorized(current,id)||current.contentHash!==entry.contentHash||row?.material!==entry.material)throw Error('current publication approval required');
 verifiedFile(row);const origin=new URL(base);if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash)throw Error('public HTTPS origin required');
 return origin.origin+`/media/approved/${current.id}/${current.contentHash}/${id}${row.extension}`;
}
export function approvedMedia(url,method,headers={},options={}){
 if(!url.startsWith('/media/approved/'))return null;
 const no={status:404,headers:{'cache-control':'no-store'},body:Buffer.alloc(0)},match=/^\/media\/approved\/([a-f0-9]{16})\/([a-f0-9]{16})\/(med_[a-f0-9]{32})(\.(?:jpg|jpeg|png|webp|mp4))$/.exec(url);
 if(!match||!['GET','HEAD'].includes(method))return no;
 try{const entry=(options.getEntry||get)(match[1]),row=(options.all||rows()).find(r=>r.mediaId===match[3]);
  if(!authorized(entry,match[3])||entry.contentHash!==match[2]||row?.material!==entry.material||row.extension!==match[4])return no;
  const file=verifiedFile(row),size=row.bytes,resultHeaders={'content-type':row.mime,'content-length':String(size),'cache-control':'no-store','x-content-type-options':'nosniff','accept-ranges':'bytes'};let start=0,end=size-1,status=200;
  if(method==='GET'&&headers.range!==undefined){const range=/^bytes=(\d*)-(\d*)$/.exec(headers.range);if(!range||!range[1]&&!range[2])throw Error('range');if(range[1]){start=Number(range[1]);end=range[2]?Number(range[2]):end;}else{const suffix=Number(range[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)throw Error('range');start=Math.max(0,size-suffix);}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return{status:416,headers:{'content-range':`bytes */${size}`,'cache-control':'no-store'},body:Buffer.alloc(0)};end=Math.min(end,size-1);status=206;resultHeaders['content-range']=`bytes ${start}-${end}/${size}`;resultHeaders['content-length']=String(end-start+1);}
  return{status,headers:resultHeaders,...(method==='HEAD'?{body:Buffer.alloc(0)}:{stream:createReadStream(file,{start,end})})};
 }catch{return no;}
}
