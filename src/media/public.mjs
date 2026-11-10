// Только специально подготовленные разрешённые изображения и MP4. Отдельный каталог,
// точное имя по SHA256; никаких списков файлов, backup или произвольных путей.
// Видео идёт потоком с Range: площадка может забирать части без загрузки всего файла в память.
import {readFileSync,realpathSync,statSync,createReadStream} from 'node:fs';
import path from 'node:path';
import {dataPath} from '../lib/env.mjs';
import {approvedMedia} from './approved.mjs';
export function publicMedia(url,method,requestHeaders={}) {
  if(url.startsWith('/media/approved/'))return approvedMedia(url,method,requestHeaders);
  if(!url.startsWith('/media/')) return null;
  const no={status:404,headers:{'cache-control':'no-store'},body:Buffer.alloc(0)};
  if(!['GET','HEAD'].includes(method) || !/^\/media\/[a-f0-9]{64}\.(jpg|png|webp|mp4)$/.test(url)) return no;
  try {
    const root=realpathSync(dataPath('public-media'));
    const file=realpathSync(path.join(root,url.slice(7)));
    if(!file.startsWith(root+path.sep)) return no;
    const ext=path.extname(file);
    const info=statSync(file);if(!info.isFile()||!info.size||info.size>(ext==='.mp4'?300:10)*1024*1024) return no;
    if(ext==='.mp4'){
      const headers={'content-type':'video/mp4','content-length':String(info.size),'accept-ranges':'bytes','cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'};
      let start=0,end=info.size-1,status=200;
      // HEAD по HTTP описывает полный GET, Range относится только к GET.
      if(method==='GET'&&requestHeaders.range!==undefined){
        const match=/^bytes=(\d*)-(\d*)$/.exec(requestHeaders.range);
        const invalid=()=>({status:416,headers:{'content-range':`bytes */${info.size}`,'cache-control':'no-store','content-length':'0'},body:Buffer.alloc(0)});
        if(!match||!match[1]&&!match[2])return invalid();
        if(match[1]){start=Number(match[1]);end=match[2]?Number(match[2]):end;}
        else {const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return invalid();start=Math.max(0,info.size-suffix);}
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=info.size||end<start)return invalid();
        end=Math.min(end,info.size-1);status=206;headers['content-range']=`bytes ${start}-${end}/${info.size}`;headers['content-length']=String(end-start+1);
      }
      return {status,headers,...(method==='HEAD'?{body:Buffer.alloc(0)}:{stream:createReadStream(file,{start,end})})};
    }
    return {status:200,headers:{'content-type':{'.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'}[ext], 'content-length':String(info.size),'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'},body:method==='HEAD'?Buffer.alloc(0):readFileSync(file)};
  } catch {return no;}
}
