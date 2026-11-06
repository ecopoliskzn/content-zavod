// Закрытая публикационная версия ролика уходит байтами только в рабочую тему.
// Неопределённая доставка не повторяется; превышение лимита не открывает исходник.
import {readFileSync,statSync} from 'node:fs';
import {env} from '../lib/env.mjs';
import {rows,blobPath} from '../media/library.mjs';
import {tgUpload} from '../lib/telegram.mjs';
export async function previewVideo(entry,previous,onState){
 const videos=(entry.media||[]).filter(m=>m.type==='video');if(!videos.length)return null;
 if(videos.length!==1)throw Error('для согласования нужен один ролик');
 if(previous?.sending)throw Error('доставка видео неоднозначна; нужен разбор оператором');
 if(previous?.complete&&previous.hash===entry.contentHash&&previous.messageIds?.length===1)return previous;
 const media=videos[0];let buffer;const limit=50*1024*1024;
 if(media.mediaId){
  const row=rows().find(r=>r.mediaId===media.mediaId&&r.material===entry.material&&r.role==='publication');
  if(!row)throw Error('нет публикационной версии ролика для согласования');
  const file=blobPath(row);if(statSync(file).size>limit)throw Error('видео для Telegram превышает 50 МБ: нужна отдельная версия предпросмотра');buffer=readFileSync(file);
 }else{
  const url=new URL(media.url);if(url.protocol!=='https:')throw Error('для видео нужен HTTPS или медиатека');
  const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('видео для согласования недоступно');
  const reader=r.body.getReader(),parts=[];let size=0;
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit){await reader.cancel();throw Error('видео для Telegram превышает 50 МБ');}parts.push(part.value);}buffer=Buffer.concat(parts);
 }
 const pending={hash:entry.contentHash,kind:'video',sending:true,complete:false};await onState(pending);
 const fields={chat_id:env('TG_GROUP_ID'),...(env('TG_TOPIC_APPROVAL')?{message_thread_id:Number(env('TG_TOPIC_APPROVAL'))}:{}),caption:'Видео для согласования',supports_streaming:true};
 const r=await tgUpload('sendVideo',fields,'video',{buffer,name:'preview.mp4'},{retries:0});
 if(r.kind!=='ok'){if(r.kind==='refused')await onState({...pending,sending:false});throw Error('видео для согласования не доставлено; повтор после проверки оператором');}
 const m=r.result;
 if(!Number.isSafeInteger(m?.message_id)||m.message_id<=0||String(m.chat?.id)!==String(fields.chat_id)||!m.video)throw Error('Telegram не подтвердил видео; повтор запрещён');
 const done={...pending,sending:false,complete:true,messageIds:[String(m.message_id)]};await onState(done);return done;
}
