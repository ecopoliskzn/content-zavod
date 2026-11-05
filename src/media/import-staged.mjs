// Приём на VPS из приватной входящей папки. Файлы компьютера оператора не удаляются.
import {readFileSync,unlinkSync,rmdirSync} from 'node:fs';import path from 'node:path';
import {dataPath} from '../lib/env.mjs';import {importMedia} from './library.mjs';
const [folder,file]=process.argv.slice(2);
try{
 if(!/^[a-f0-9-]{36}$/.test(folder||'')||!/^input\.[a-z0-9]{1,10}$/.test(file||''))throw Error('неверное имя пакета');
 const dir=dataPath('media-inbox',folder),source=path.join(dir,file),metadata=path.join(dir,'options.json');
 const row=await importMedia(source,JSON.parse(readFileSync(metadata,'utf8')));
 unlinkSync(source);unlinkSync(metadata);rmdirSync(dir);
 console.log(JSON.stringify({mediaId:row.mediaId,role:row.role,version:row.version,bytes:row.bytes,public:false}));
}catch{console.error('Импорт не завершён: проверьте квоту и параметры пакета; исходник оператора сохранён');process.exitCode=2;}
