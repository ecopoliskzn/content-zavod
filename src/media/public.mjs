// Только специально подготовленные разрешённые изображения. Отдельный каталог,
// точное имя по SHA256; никаких списков файлов, backup или произвольных путей.
import {readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {dataPath} from '../lib/env.mjs';
export function publicMedia(url,method) {
  if(!url.startsWith('/media/')) return null;
  const no={status:404,headers:{'cache-control':'no-store'},body:Buffer.alloc(0)};
  if(!['GET','HEAD'].includes(method) || !/^\/media\/[a-f0-9]{64}\.(jpg|png|webp)$/.test(url)) return no;
  try {
    const root=realpathSync(dataPath('public-media'));
    const file=realpathSync(path.join(root,url.slice(7)));
    if(!file.startsWith(root+path.sep)) return no;
    const info=statSync(file);if(!info.isFile()||info.size>10*1024*1024) return no;
    const ext=path.extname(file);
    return {status:200,headers:{'content-type':{'.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'}[ext], 'content-length':String(info.size),'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'},body:method==='HEAD'?Buffer.alloc(0):readFileSync(file)};
  } catch {return no;}
}
