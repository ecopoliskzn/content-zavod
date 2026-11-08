// Однократная техническая проба: два синтетических JPEG в служебной теме, без публикаций.
// Telegram upload/download настоящий; входящие update смоделированы подписанным запросом.
// Это не получение нового сообщения человека и не его согласие на публикацию.
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';import path from 'node:path';import {createHash} from 'node:crypto';
import {dataPath,env,PROJECT_ROOT,wrongUser} from '../src/lib/env.mjs';import {readJson,lock} from '../src/lib/files.mjs';
import {tgUploadMany} from '../src/lib/telegram.mjs';import {instance} from '../src/bot/media-intake-runtime.mjs';
import {rows,blobPath} from '../src/media/library.mjs';
if(wrongUser()||!process.argv.includes('--run-once'))throw Error('нужен пользователь завода и --run-once');
const config=readJson(dataPath('media-intake','config.json'),{});if(!config.enabled)throw Error('приём выключен');
const dir=dataPath('media-intake','technical-probe');mkdirSync(dir,{recursive:true,mode:0o700});
const marker=path.join(dir,'receipt.json'),save=value=>{writeFileSync(marker+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(marker+'.tmp',marker);};
const unlock=lock(path.join(dir,'run.lock'),240000);if(!unlock)throw Error('проба занята');
try{
 let receipt=readJson(marker,{});if(receipt.phase==='verified'){console.log(JSON.stringify(receipt.evidence));}else{
  if(['uploading','unknown'].includes(receipt.phase))throw Error('исход прежней отправки требует сверки');
  if(receipt.phase!=='uploaded'){
   const files=['red','blue'].map((color,i)=>{const file=path.join(dir,'s0-probe-'+(i+1)+'.jpg');if(!existsSync(file))execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=${color}:s=64x64`,'-frames:v','1','-threads','1',file],{timeout:15000});return file;});
   save({phase:'uploading'});
   const response=await tgUploadMany('sendMediaGroup',{chat_id:config.groupId,message_thread_id:config.topicId,media:files.map((_,i)=>({type:'document',media:'attach://probe'+i,...(i===0?{caption:'Техническая проверка S0: синтетический комплект. Не публиковать.'}:{})}))},files.map((file,i)=>({field:'probe'+i,file})),{timeoutMs:60000});
   if(!response.data?.ok||response.result?.length!==2){save({phase:'unknown'});throw Error('отправка не подтверждена');}
   receipt={phase:'uploaded',files:files.map((file,i)=>({local:file,messageId:response.result[i].message_id,album:response.result[i].media_group_id,file:response.result[i].document})),updateBase:Date.now()};save(receipt);
  }
  const app=instance(),actor=config.authors.at(-1),post=update=>fetch('http://127.0.0.1:3100/tg/update',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':env('TG_WEBHOOK_SECRET')},body:JSON.stringify(update)});
  const updates=receipt.files.map((item,i)=>({update_id:receipt.updateBase+i,message:{message_id:item.messageId,chat:{id:Number(config.groupId),type:'supergroup'},message_thread_id:config.topicId,from:{id:Number(actor)},media_group_id:item.album,caption:i===0?'Техническая проверка: показать синтетический комплект, не публиковать.':'',document:item.file}}));
  for(const update of [...updates,updates[0]])if((await post(update)).status!==200)throw Error('durable приём не подтверждён');
  const outsider={...updates[0],update_id:receipt.updateBase+100,message:{...updates[0].message,from:{id:0}}};await post(outsider);
  let material;
  for(let i=0;i<40;i++){
   material=Object.values(app.store.read().materials).find(r=>r.sources.some(s=>s.messageId===receipt.files[0].messageId));
   if(material?.files.length===2&&material.files.every(f=>f.status==='verified')&&material.card.status==='sent')break;
   await new Promise(r=>setTimeout(r,1000));
  }
  if(!material||material.files.length!==2||material.files.some(f=>f.status!=='verified')||material.card.status!=='sent')throw Error('импорт или карточка не подтверждены');
  if(app.store.read().events['up:'+outsider.update_id])throw Error('чужой автор принят');
  const all=rows();for(const source of receipt.files){const f=material.files.find(f=>f.messageId===source.messageId),row=all.find(r=>r.mediaId===f.mediaId);const expected=createHash('sha256').update(readFileSync(source.local)).digest('hex');
   if(!row||row.role!=='original'||row.sha256!==expected||createHash('sha256').update(readFileSync(blobPath(row))).digest('hex')!==expected)throw Error('байты закрытого оригинала отличаются');
   const publicResponse=await fetch(env('PUBLIC_BASE_URL').replace(/\/+$/,'')+'/media/'+row.sha256+'.jpg',{method:'HEAD'});if(publicResponse.status!==404)throw Error('оригинал открыт');
  }
  const evidence={type:'synthetic-signed-ingress-with-live-telegram-files',checked_at:new Date().toISOString(),serverVersion:readFileSync(path.join(PROJECT_ROOT,'VERSION'),'utf8').trim(),filesVerified:2,duplicateCreated:false,outsiderRejected:true,originalsPublic:false,cardId:material.card.messageId,topicId:config.topicId,materialId:material.id,liveHumanIngressVerified:false,publicationApproved:false,publicationsSent:0,artifact_ref:'media-intake/technical-probe/receipt.json'};
  app.edit(material.id,material.revision,material.author,{mode:'archive'});
  save({phase:'verified',evidence});console.log(JSON.stringify(evidence));
 }
}finally{unlock();}
