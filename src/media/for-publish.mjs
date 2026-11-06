// YouTube уже получил файл через загрузку оператора: адаптер открывает этот videoId,
// проверяя отпечаток согласованного содержимого. Ему не нужен новый адрес исходника.
// Остальные площадки по-прежнему получают файлы только штатным медиапутём.
import {resolveEntryMedia} from './library.mjs';
export async function publicationMedia(entry,{resolve=resolveEntryMedia}={}){
  return entry.channel==='youtube'?entry:resolve(entry);
}
