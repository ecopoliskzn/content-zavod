// YouTube уже получил файл через загрузку оператора: адаптер открывает этот videoId,
// проверяя отпечаток согласованного содержимого. Ему не нужен новый адрес исходника.
// Остальные площадки по-прежнему получают файлы только штатным медиапутём.
import {resolveEntryMedia} from './library.mjs';
import {env} from '../lib/env.mjs';
export async function publicationMedia(entry,{resolve=resolveEntryMedia,manual=false}={}){
  if(entry.channel==='youtube'&&!manual)return entry;
  const ready=await resolve(entry,{preferApproved:entry.channel==='instagram'}),relay=env('IG_RELAY_URL');
  if(!relay||!['instagram','threads'].includes(entry.channel))return ready;
  const proxy=new URL(relay);if(proxy.protocol!=='https:'||proxy.username||proxy.password)throw Error('неверный адрес медиарелея');
  const throughRelay=value=>{if(!value)return value;const url=new URL(value);return url.origin===new URL(env('PUBLIC_BASE_URL')).origin&&url.pathname.startsWith('/media/approved/')?proxy.origin+url.pathname:value;};
  return{...ready,media:(ready.media||[]).map(m=>({...m,url:throughRelay(m.url),...(m.cover?{cover:throughRelay(m.cover)}:{})}))};
}
