// Карточка для решения человека: сам материал, момент выхода и текущий результат.
// Источники и машинные проверки остаются в очереди; служебные адреса сюда не попадают.
import {channel} from '../lib/config.mjs';
import {h} from '../lib/telegram.mjs';
import {human} from '../lib/time.mjs';
import {commissioning,hasRequestedTime} from '../queue/timing.mjs';
import {describe} from '../video/describe.mjs';

const formats={thread:'Ветка',post:'Пост',article:'Статья',video:'Видео',short:'Короткое видео',reel:'Ролик',carousel:'Карусель',story:'История',reply:'Ответ на комментарий'};
export function compactCardText(entry,verdict={block:[],warn:[]},footer=''){
 const cfg=channel(entry.channel),images=(entry.media||[]).filter(m=>m.type==='image').length;
 const head=[cfg.title,formats[entry.kind]||'Публикация',images?`${images} фото`:''].filter(Boolean).join(' · ');
 const status={draft:'На согласование',review:'На согласование',approved:'Одобрено · ожидает выпуска',running:'Выпускается',published:'Опубликовано',handed:'Передано сотруднику · ожидает выкладки',failed:'Не удалось выпустить',expired:'Не удалось выпустить вовремя',rework:'Нужна правка',cancelled:'Отменено'}[entry.status]||'На согласование';
 const rows=[`<b>${h(head)}</b>`,status];
 if(!['published','cancelled','handed','running'].includes(entry.status)){
  if(entry.timing?.mode==='period')rows.push(`Период: ${h(entry.timing.from.replace('T',' '))} — ${h(entry.timing.to.replace('T',' '))} МСК`);
  else if(entry.timing?.delayMin)rows.push(`Через ${entry.timing.delayMin} мин. после одобрения`);
  else rows.push(commissioning()&&!hasRequestedTime(entry)||!entry.timing||['after-approval','urgent'].includes(entry.timing.mode)?'Сразу после одобрения':`Выход: ${human(entry)} МСК`);
 }
 if(entry.context&&entry.kind==='reply')rows.push('',`Комментарий: «${h(String(entry.context).slice(0,600))}»`);
 rows.push('');
 if(entry.title)rows.push(`<b>${h(entry.title)}</b>`,'');
 if(entry.kind==='thread')for(const [i,p] of (entry.posts||[]).entries())rows.push(`${i+1}. ${h(p)}`,'');
 else{
  const videoDescription=['youtube','rutube'].includes(entry.channel)&&['video','short'].includes(entry.kind)||entry.channel==='vk'&&entry.kind==='video';
  const body=String(videoDescription?describe(entry):entry.text||'');
  rows.push(h(['telegram','vk'].includes(entry.channel)?body.replace(/<[^>]+>/g,''):body),'');
 }
 for(const row of entry.buttons||[])for(const button of row)rows.push(`Кнопка «${h(button.text)}»: ${h(button.url)}`);
 if(entry.link)rows.push(h(entry.link));
 if(entry.ask&&['draft','review','rework'].includes(entry.status))rows.push('',`❓ ${h(entry.ask)}`);
 if(verdict.block?.length)rows.push('','Нужна правка перед согласованием.');
 if(entry.status==='published'&&entry.result?.link)rows.push('',h(entry.result.link));
 if(entry.status==='failed')rows.push('','Оператор устраняет причину. Повторное одобрение неизменного материала не требуется.');
 if(footer)rows.push('',footer);
 return rows.join('\n').trim();
}
