// Нативные фотографии для согласования: сначала проверенный альбом в закрытую
// рабочую тему, затем связанная карточка. Обрыв не разрешает слепую повторную отправку.
import {readFileSync} from 'node:fs';
import {env} from '../lib/env.mjs';import {h,tgUpload,tgUploadMany} from '../lib/telegram.mjs';
import {photoBytes} from '../channels/telegram-album.mjs';
import {rows,blobPath} from '../media/library.mjs';
export async function previewPhotos(entry,previous,onState){
 const photos=(entry.media||[]).filter(m=>m.type==='image');if(!photos.length)return null;
 if(photos.length>10)throw Error('для согласования поддерживается до 10 фото одним альбомом');
 if(previous?.sending)throw Error('доставка предыдущего превью неоднозначна; автоматический повтор запрещён, нужна проверка оператором');
 if(previous?.complete&&previous.hash===entry.contentHash&&previous.messageIds?.length===photos.length)return previous;
 const files=[];
 for(let i=0;i<photos.length;i++){
  const m=photos[i];let buffer;
  if(m.mediaId){const row=rows().find(r=>r.mediaId===m.mediaId&&r.material===entry.material&&r.role!=='original');if(!row)throw Error('нет публикационной версии для превью');buffer=readFileSync(blobPath(row));}
  else buffer=await photoBytes(m.url);
  if(buffer.length>10*1024*1024)throw Error('фото превью превышает 10 МБ');
  files.push({field:`preview${i}`,file:{buffer,name:`preview${i}.jpg`}});
 }
 const pending={hash:entry.contentHash,sending:true,complete:false};await onState(pending);
 const fields={chat_id:env('TG_GROUP_ID'),...(env('TG_TOPIC_APPROVAL')?{message_thread_id:Number(env('TG_TOPIC_APPROVAL'))}:{})};
 const caption=`Фотографии для согласования · ${h(entry.name)}`;
 let r;if(files.length===1)r=await tgUpload('sendPhoto',{...fields,caption,parse_mode:'HTML'},'photo',files[0].file);
 else r=await tgUploadMany('sendMediaGroup',{...fields,media:files.map((f,i)=>({type:'photo',media:`attach://${f.field}`,...(i===0?{caption,parse_mode:'HTML'}:{})}))},files);
 if(r.kind!=='ok'){if(r.kind==='refused')await onState({...pending,sending:false});throw Error('фото для согласования не доставлены; при сетевом обрыве сначала нужна проверка оператором');}
 const sent=Array.isArray(r.result)?r.result:[r.result];const ids=sent.map(m=>String(m?.message_id||''));
 if(sent.length!==photos.length||ids.some(id=>!/^\d+$/.test(id)||Number(id)<=0)||new Set(ids).size!==ids.length||sent.some(m=>String(m?.chat?.id)!==String(fields.chat_id)||!m?.photo?.length)||(photos.length>1&&(!sent[0]?.media_group_id||sent.some(m=>m.media_group_id!==sent[0].media_group_id)))){await onState({...pending,observedIds:ids.filter(id=>/^\d+$/.test(id))});throw Error('превью доставлено неполно или неоднозначно; карточка не отправлена, требуется проверка');}
 const done={hash:entry.contentHash,sending:false,complete:true,messageIds:ids,mediaGroupId:sent[0].media_group_id||null};await onState(done);return done;
}
