// Вызовы Telegram Bot API: через релей с сервера, напрямую с компьютера оператора.
//
// С сервера в России api.telegram.org не отвечает (TCP открывается, TLS режется), и
// входящие обновления до сервера тоже не доходят. Поэтому рядом живёт релей за границей:
// он принимает обновления от Telegram и наши вызовы к Bot API. Данных релей не хранит.
//
// Токен бота на сервере не лежит вовсе: он в секретах релея. Серверу известны только
// адрес релея и общий секрет. Прямой режим (TG_BOT_TOKEN в окружении) оставлен для
// компьютера оператора и для второго узла за границей.
//
// Файлы. Облачный Bot API берёт по адресу только то, до чего может дотянуться сам, а до
// российских хранилищ он не дотягивается («failed to get HTTP URL content»). Поэтому
// фото и видео идут байтами через маршрут /upload релея (предел Bot API — 50 МБ).

import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "./env.mjs";
import { request } from "./http.mjs";

/** Экранирование для parse_mode=HTML. */
export const h = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function target(method) {
  const relay = env("TG_RELAY_URL");
  if (relay) return { url: `${relay.replace(/\/+$/, "")}/api/${method}`, headers: { "x-relay-secret": env("TG_RELAY_SECRET") }, upload: `${relay.replace(/\/+$/, "")}/upload/${method}` };
  const token = env("TG_BOT_TOKEN");
  if (token) return { url: `https://api.telegram.org/bot${token}/${method}`, headers: {}, upload: `https://api.telegram.org/bot${token}/${method}` };
  return null;
}

/**
 * Любой метод Bot API. Никогда не бросает: сетевой сбой возвращается тем же видом,
 * что и отказ площадки, с kind = "network".
 *
 * ПОВТОР. По умолчанию запрос повторяется один раз: так живут сообщения в рабочую
 * группу, где потерянная карточка хуже задвоенной. Публикация в канал и рассылка людям
 * зовут с retries: 0. Сетевой сбой не говорит, дошло ли сообщение: запрос мог уйти, а
 * ответ потеряться. Слепой повтор через три секунды давал бы второй пост в канале, и
 * сверка «не вышел ли пост» до этого места не доходила: повтор сидел внутри одного вызова.
 */
export async function tg(method, body = {}, { timeoutMs = 15_000, retries = 1 } = {}) {
  const t = target(method);
  if (!t) return { kind: "refused", status: 0, data: null, error: "не настроен ни релей (TG_RELAY_URL), ни прямой токен (TG_BOT_TOKEN)" };
  const res = await request(t.url, { method: "POST", headers: { "content-type": "application/json", ...t.headers }, body: JSON.stringify(body), timeoutMs, retries, retryDelayMs: 3_000 });
  return { ...res, result: res.data?.result };
}

/**
 * Метод с файлом (sendPhoto, sendVideo, sendDocument): multipart, байтами.
 * @param {string|{ buffer: Buffer|Uint8Array, name: string }} file путь на диске либо байты с именем
 */
export async function tgUpload(method, fields, fileField, file, { timeoutMs = 180_000,retries=0 } = {}) {
  const t = target(method);
  if (!t) return { kind: "refused", status: 0, data: null, error: "не настроен ни релей, ни прямой токен" };
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) body.append(k, typeof v === "string" ? v : JSON.stringify(v));
  const bytes = typeof file === "string" ? readFileSync(file) : file.buffer;
  const fileName = typeof file === "string" ? path.basename(file) : file.name;
  if (bytes.length > 50 * 1024 * 1024) return { kind: "refused", status: 0, data: null, error: `файл ${(bytes.length / 1048576).toFixed(0)} МБ: облачный Bot API берёт до 50 МБ, ролик нужно пережать` };
  body.append(fileField, new Blob([bytes]), fileName);
  const res = await request(t.upload, { method: "POST", headers: t.headers, body, timeoutMs,retries });
  return { ...res, result: res.data?.result };
}

/** Альбом: уникальные attach-поля, повтор имени файла допустим. Сетевого повтора нет. */
export async function tgUploadMany(method, fields, files, { timeoutMs = 180_000 } = {}) {
  const refuse = error => ({kind:'refused',status:0,error});
  const t=target(method); if(!t) return refuse('не настроен Telegram');
  const names=new Set(); let total=0; const body=new FormData();
  try {
    for(const [k,v] of Object.entries(fields)) if(v!==undefined && v!==null) body.append(k,typeof v==='string'?v:JSON.stringify(v));
    for(const {field,file} of files) {
      if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) || names.has(field) || Object.hasOwn(fields,field)) return refuse('неоднозначное имя attach-поля');
      names.add(field);
      const bytes=typeof file==='string'?readFileSync(file):file.buffer;
      total+=bytes.length;
      if(bytes.length>10*1024*1024 || total>50*1024*1024) return refuse('фото превышает 10 МБ или альбом превышает 50 МБ');
      body.append(field,new Blob([bytes],{type:'image/jpeg'}),typeof file==='string'?path.basename(file):file.name);
    }
    const media=typeof fields.media==='string'?JSON.parse(fields.media):fields.media;
    const refs=media.map(m=>String(m.media).startsWith('attach://')?String(m.media).slice(9):'');
    if(refs.length!==names.size || new Set(refs).size!==refs.length || refs.some(r=>!names.has(r))) return refuse('attach-ссылки не соответствуют файлам');
  } catch { return refuse('не удалось подготовить multipart альбома'); }
  const res=await request(t.upload,{method:'POST',headers:t.headers,body,timeoutMs,retries:0});
  return {...res,result:res.data?.result};
}

export const sendMessage = (chatId, text, extra = {}, options = {}) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra }, options);

export const editMessageText = (chatId, messageId, text, extra = {}) =>
  tg("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });

export const answerCallback = (id, text = "", alert = false) =>
  tg("answerCallbackQuery", { callback_query_id: id, ...(text ? { text, show_alert: alert } : {}) });

/** Инлайн-кнопки: [[{ text, data }], [{ text, url }]] → reply_markup. */
export function keyboard(rows) {
  return { reply_markup: { inline_keyboard: rows.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) } };
}

/** Длинный текст кусками по 3900 знаков: предел сообщения 4096, запас на разметку. */
export function chunks(text, size = 3900) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}
