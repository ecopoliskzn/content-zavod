// Пакет на ручную выкладку: когда площадка не даёт программной публикации.
//
// Так выходит Дзен (программного доступа к публикации у него нет), Rutube до получения
// ключа и записи ВКонтакте с фото или видео, пока у завода нет ключа с нужными правами.
//
// Пакет — сообщение в тему «Выложить руками» рабочей группы: что выложить, куда, когда,
// готовый текст и ссылки на файлы. Под ним кнопка «Выложено». Человек клиента вставляет
// текст на площадку, нажимает кнопку и отвечает на сообщение ссылкой на публикацию:
// ссылка попадает в журнал, и материал участвует в отчёте наравне с остальными.
//
// Согласование то же самое: пакет уходит только по одобренной записи и в её слот.

import { channel as channelCfg } from "../lib/config.mjs";
import { h, toGroup } from "../lib/notify.mjs";
import { human } from "../lib/time.mjs";
import {deliverManual} from './manual-delivery.mjs';

/**
 * Ответ на комментарий: согласованный текст и ссылка на комментарий уходят сотруднику.
 * Ответить программой завод не берётся: десять ответов, отправленных конвейером, читаются
 * как конвейер, а на вопрос человека должен ответить человек с аккаунта компании.
 */
export async function sendReply(entry, { onState,deliver=toGroup } = {}) {
  if(!String(entry.text||'').trim())return{ok:false,retry:false,error:'Нет согласованного текста ответа; пакет не отправлен.'};
  const cfg = channelCfg(entry.channel);
  const head = [
    `💬 <b>Ответить на комментарий · ${h(cfg.title)}</b>`,
    entry.context ? `Комментарий: «${h(String(entry.context).slice(0, 600))}»` : "",
    "",
    `1. Откройте комментарий: ${h(entry.link)}`,
    "2. Ответьте с аккаунта компании текстом из следующего сообщения.",
    "3. Нажмите «Отвечено».",
  ].filter((x) => x !== "").join("\n");
  return deliverManual(entry,{kind:'reply',head,body:entry.text||'',buttons:[[{text:'✅ Отвечено',data:`d:done:${entry.id}`}]],onState,deliver});
}

/**
 * @param {object} entry запись очереди
 * @param {{ steps: string[], onState?: Function, why?: string }} opts steps — что сделать человеку, по шагам
 * @returns {Promise<{ ok: boolean, manual?: boolean, note?: string, error?: string, retry?: boolean }>}
 */
export async function sendPackage(entry, { steps, onState, why = "",deliver=toGroup }) {
  const cfg = channelCfg(entry.channel);
  const rows = [`📦 <b>Выложить руками · ${h(cfg.title)}</b>`, `Когда: ${human(entry)} по Москве. Запись одобрена.`];
  if (why) rows.push(`<i>${h(why)}</i>`);
  rows.push("", "<b>Что сделать</b>", ...steps.map((s, i) => `${i + 1}. ${h(s)}`));
  for (const m of entry.media || []) rows.push("", `${m.type === "video" ? "🎬 Ролик" : "🖼 Картинка"}: ${h(m.url)}`, ...(m.cover ? [`Обложка: ${h(m.cover)}`] : []));
  if (entry.tags?.length) rows.push("", `Метки: ${h(entry.tags.join(", "))}`);
  rows.push("", "<b>Текст для вставки следующим сообщением.</b> После выкладки нажмите «Выложено» и ответьте на это сообщение ссылкой на публикацию.");
  // Текст отдельным сообщением и без разметки: его копируют целиком одним нажатием.
  const body = [entry.title ? entry.title : "", entry.text || (entry.posts || []).join("\n\n")].filter(Boolean).join("\n\n");
  return deliverManual(entry,{kind:'package',head:rows.join('\n'),body,buttons:[[{text:'✅ Выложено',data:`d:done:${entry.id}`}]],onState,deliver});
}
