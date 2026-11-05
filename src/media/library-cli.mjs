// Один вход: закрытый импорт файлов/папок на VPS, реестр, синхронизация и восстановление.
import {statSync,readdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';import {dataDir,env} from '../lib/env.mjs';
import {importMedia,rows,libraryStatus,replicate,restoreBlob,adoptPublic,auditLibrary,canImportFile} from './library.mjs';
const opt=n=>(process.argv.find(x=>x.startsWith(`--${n}=`))||'').slice(n.length+3);
const flag=n=>process.argv.includes(`--${n}`);
// Учитываем одновременно входящий пакет и копию в библиотеке, оставляем системе 1 ГБ.
export function checkTransferSpace(status,bytes){
 if(!Number.isSafeInteger(status.quotaBytes)||status.quotaBytes<=0||bytes>status.quotaBytes)throw Error('файл превышает квоту сервера; передача не начиналась');
 if(!Number.isFinite(status.freeBytes)||bytes*2+1024*1024*1024>status.freeBytes)throw Error('недостаточно подтверждённого места для безопасной передачи; исходник сохранён');
}
function files(file){if(statSync(file).isFile())return[file];return readdirSync(file,{withFileTypes:true}).filter(x=>!x.name.startsWith('.')&&!x.isSymbolicLink()).flatMap(x=>files(path.join(file,x.name)));}
export async function libraryCli(){try{
 if(flag('status')){console.log(JSON.stringify(libraryStatus()));return 0;}
 if(flag('audit')){const r=await auditLibrary();console.log(JSON.stringify(r));return r.ok?0:2;}
 if(flag('list')){console.log(JSON.stringify(rows().filter(r=>!opt('material')||r.material===opt('material')).map(({mediaId,material,role,variant,parent,version,bytes,extension,replica})=>({mediaId,material,role,variant,parent,version,bytes,extension,replicated:replica?.status==='verified'})),null,2));return 0;}
 if(opt('sync')){const r=await replicate(opt('sync'));console.log(JSON.stringify({mediaId:r.mediaId,replicated:true}));return 0;}
 if(opt('restore')){await restoreBlob(opt('restore'));console.log('Файл восстановлен, SHA256 совпадает.');return 0;}
 if(opt('adopt-public')){adoptPublic(opt('adopt-public'),opt('url'),{confirmed:flag('confirm-public')});console.log('Разрешённая ссылка связана с публикационной версией.');return 0;}
 if(!opt('import'))throw Error('укажите --import=<файл или папка> --material=<материал> либо --status/--list/--audit');
 const options={material:opt('material'),role:opt('role')||'original',variant:opt('variant')||'',parent:opt('parent')||null,source:opt('source')||'оператор: импорт файла'};
 if(!options.material)throw Error('нужен --material');
 const importRoot=opt('import'),folderImport=statSync(importRoot).isDirectory();
 const variantFor=file=>options.variant||(folderImport?path.relative(importRoot,file).split(path.sep).join('/'):path.basename(file));
 const server=opt('server')||env('MEDIA_SSH_TARGET');
 if(server){
  if(!/^[a-z][a-z0-9_-]*@[a-zA-Z0-9.-]+$/.test(server))throw Error('неверный SSH-адрес');
  for(const file of files(opt('import'))){
   if(!canImportFile(file))throw Error('неподдерживаемое имя исходника или файл с секретами');
   const bytes=statSync(file).size;
   const remoteStatus=JSON.parse(execFileSync('ssh',['-o','BatchMode=yes',server,'cd /opt/ecopolis-zavod/current && node src/media/upload.mjs --status'],{encoding:'utf8'}));
   checkTransferSpace(remoteStatus,bytes);
   const name=randomUUID(),remote=`/opt/ecopolis-data/media-inbox/${name}`,temp=mkdtempSync(path.join(tmpdir(),'ecopolis-media-'));
   try{
    const metadata=path.join(temp,'options.json');writeFileSync(metadata,JSON.stringify({...options,variant:variantFor(file),originalName:path.basename(file),source:options.source+': '+path.basename(file)}),{mode:0o600});
    execFileSync('ssh',['-o','BatchMode=yes',server,`umask 077; mkdir -p ${remote}`]);
    execFileSync('scp',['-q','-o','BatchMode=yes',file,`${server}:${remote}/input${path.extname(file).toLowerCase()}`]);
    execFileSync('scp',['-q','-o','BatchMode=yes',metadata,`${server}:${remote}/options.json`]);
    console.log(execFileSync('ssh',['-o','BatchMode=yes',server,`cd /opt/ecopolis-zavod/current && node src/media/import-staged.mjs ${name} input${path.extname(file).toLowerCase()}`],{encoding:'utf8'}).trim());
   }finally{rmSync(temp,{recursive:true,force:true});}
  }return 0;
 }
 if(!dataDir().startsWith('/opt/')&&!flag('local'))throw Error('на компьютере используйте --server=zavod@104.171.136.64; --local предназначен для изолированной проверки');
 for(const file of files(opt('import'))){const row=await importMedia(file,{...options,variant:variantFor(file)});console.log(JSON.stringify({mediaId:row.mediaId,role:row.role,version:row.version,bytes:row.bytes,public:false}));}return 0;
}catch(e){console.error(`Медиатека: ${e.message}`);return 2;}}
