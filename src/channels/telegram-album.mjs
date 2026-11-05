// Альбом фотографий передаётся одним multipart через релей. До отправки все файлы
// подготовлены. Неопределённый или неполный ответ требует человека: одна подпись
// на витрине не подтверждает все фотографии и не разрешает повторную отправку.
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {dataPath} from '../lib/env.mjs';
import {tgUploadMany} from '../lib/telegram.mjs';

function captionLength(text) {
  // Консервативная проверка: неизвестные сущности не сокращаем. Telegram проверяет
  // сам синтаксис HTML; отказ не меняет исходный текст и не снимает проверки.
  return [...String(text).replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot);/g,'x').replace(/&#(?:\d+|x[\da-f]+);/gi,'x')].length;
}
export async function photoBytes(url) {
  if(url.startsWith('local:')) {
    const root=realpathSync(dataPath('media'));
    const file=realpathSync(path.resolve(root,url.slice(6)));
    if(!file.startsWith(root+path.sep)) throw Error('файл вне каталога media');
    if(statSync(file).size>10*1024*1024) throw Error('фото превышает 10 МБ');
    return readFileSync(file);
  }
  const target=new URL(url);if(target.protocol!=='https:') throw Error('нужен HTTPS-адрес фото');
  const res=await fetch(target,{signal:AbortSignal.timeout(30000)});
  if(!res.ok) throw Error(`фото недоступно: HTTP ${res.status}`);
  const reader=res.body.getReader();let size=0;const chunks=[];
  while(true) {const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>10*1024*1024){await reader.cancel();throw Error('фото превышает 10 МБ');}chunks.push(r.value);}
  return Buffer.concat(chunks);
}
export async function publishAlbum(entry,chat,ctx={}) {
  const count=entry.media.length;
  const fail=error=>({ok:false,retry:false,error});
  if(count<2||count>10||entry.media.some(m=>!['image','photo'].includes(m.type))) return fail('альбом Telegram: требуется от 2 до 10 фотографий');
  if(entry.buttons?.length) return fail('кнопки не поддерживаются sendMediaGroup; согласуйте запись без кнопок');
  if(captionLength(entry.text)>1024) return fail('подпись альбома превышает 1024 знака после разбора разметки');
  const hash=createHash('sha256').update(JSON.stringify([entry.text,entry.media.map(m=>m.mediaId?{type:m.type,mediaId:m.mediaId,coverMediaId:m.coverMediaId||null}:m)])).digest('hex');
  const previous=entry.result || {};
  if(previous.tgAlbumComplete && previous.tgAlbumHash===hash && previous.messageIds?.length===count && new Set(previous.messageIds).size===count && previous.mediaGroupId) {
    return {ok:true,id:previous.messageIds[0],messageIds:previous.messageIds,mediaGroupId:previous.mediaGroupId,link:previous.link || '',note:'полный ответ альбома сохранён прошлой попыткой'};
  }
  if(previous.tgSending || previous.tgAlbumComplete) return fail('прошлая отправка альбома неоднозначна: проверьте все фотографии в канале; автоматический повтор запрещён, одна подпись не подтверждает весь альбом');
  const files=[];const media=[];let size=0;
  try {
    for(let i=0;i<count;i++) {
      const buffer=await photoBytes(entry.media[i].url);size+=buffer.length;
      if(size>50*1024*1024) return fail('альбом превышает 50 МБ');
      files.push({field:`photo${i}`,file:{buffer,name:`photo${i}.jpg`}});
      media.push({type:'photo',media:`attach://photo${i}`,...(i===0?{caption:entry.text,parse_mode:'HTML'}:{})});
    }
  } catch {return {ok:false,retry:true,error:'фотографии альбома не подготовлены; отправка в Telegram не начиналась'};}
  if(ctx.onState) await ctx.onState({tgSending:true,tgAlbumHash:hash,tgAlbumCount:count});
  const r=await tgUploadMany('sendMediaGroup',{chat_id:chat,media},files);
  if(r.kind!=='ok') {
    if(r.kind==='refused' && ctx.onState) await ctx.onState({tgSending:false});
    return {ok:false,retry:r.kind==='network',error:r.error};
  }
  const rows=Array.isArray(r.result)?r.result:[];
  const ids=rows.filter(m=>Number.isSafeInteger(m?.message_id)&&m.message_id>0).map(m=>String(m.message_id));
  const group=rows[0]?.media_group_id;
  const sameChat=m=>String(chat).startsWith('@') ? m.chat?.username?.toLowerCase()===String(chat).slice(1).toLowerCase() : String(m.chat?.id)===String(chat);
  const complete=rows.length===count && ids.length===count && new Set(ids).size===count && group && rows.every(m=>m.media_group_id===group && sameChat(m) && m.photo?.length);
  if(!complete) {
    if(ctx.onState) await ctx.onState({tgSending:true,tgAlbumComplete:false,tgAlbumObservedMessageIds:ids});
    return fail('Telegram вернул неполный или противоречивый ответ альбома; нужна ручная проверка, повтор запрещён');
  }
  const handle=rows[0].chat.username;const internal=String(rows[0].chat.id).replace(/^-100/,'');
  const link=handle?`https://t.me/${handle}/${ids[0]}`:`https://t.me/c/${internal}/${ids[0]}`;
  const state={tgSending:false,tgAlbumComplete:true,tgAlbumHash:hash,messageIds:ids,mediaGroupId:String(group),link};
  if(ctx.onState) await ctx.onState(state);
  return {ok:true,id:ids[0],messageIds:ids,mediaGroupId:String(group),link};
}
