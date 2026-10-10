// Telegram-канал: пост текстом, с картинкой или с видео, с кнопками под постом.
//
// СТАТУС: порядок действий взят из нашего боевого скрипта публикации в канал.
// Что важно знать:
//  · публикует БОТ, добавленный администратором канала. Кнопку под постом может
//    поставить только бот-автор: пост, набранный руками в приложении, её не получит;
//  · подпись к фото и видео — до 1024 знаков, текстовый пост — до 4096. Длинный текст
//    с картинкой делается текстом с превью ссылки, а не подписью;
//  · видео через облачный Bot API — до 50 МБ. Больше — пережать до постановки;
//  · у поста с вложением текст лежит в подписи, и правится он другим методом
//    (editMessageCaption), чем у текстового (editMessageText);
//  · по адресу Telegram берёт только файлы, до которых дотягивается сам. До российских
//    хранилищ он не дотягивается, поэтому при отказе файл скачивается сервером и
//    отправляется байтами;
//  · число просмотров бот у Telegram узнать не может: цифры снимаются с веб-витрины
//    t.me/s/<канал> (см. metrics ниже).

import { env } from "../lib/env.mjs";
import { request, sleep } from "../lib/http.mjs";
import { keyboard, tg, tgUpload } from "../lib/telegram.mjs";

export const name = "telegram";

const channelId = () => env("TG_CHANNEL"); // @имя_канала или -100…

function linkOf(message) {
  const chat = message?.chat;
  if (chat?.username) return `https://t.me/${chat.username}/${message.message_id}`;
  const internal = String(chat?.id || "").replace(/^-100/, "");
  return internal ? `https://t.me/c/${internal}/${message.message_id}` : "";
}

async function fetchBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`хранилище ответило ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * @param {{ text: string, media?: Array<{type:string,url:string,cover?:string}>, buttons?: Array<Array<{text:string,url:string}>> }} entry
 */
export async function publish(entry) {
  const chat = channelId();
  if (!chat) return { ok: false, error: "нет TG_CHANNEL", retry: false };
  const buttons = entry.buttons?.length ? keyboard(entry.buttons) : {};
  const media = entry.media?.[0];
  let res;

  if (!media) {
    res = await tg("sendMessage", { chat_id: chat, text: entry.text, parse_mode: "HTML", ...buttons });
  } else {
    const method = media.type === "video" ? "sendVideo" : "sendPhoto";
    const field = media.type === "video" ? "video" : "photo";
    const base = { chat_id: chat, caption: entry.text, parse_mode: "HTML", ...(media.type === "video" ? { supports_streaming: true } : {}), ...buttons };
    res = await tg(method, { ...base, [field]: media.url }, { timeoutMs: 60_000 });
    // Отказ «не смог забрать по адресу» лечится отправкой байтами.
    if (res.kind === "refused" && /failed to get HTTP URL content|wrong (?:file identifier|type of the web page)|wrong remote file/i.test(res.error || "")) {
      try {
        const buffer = await fetchBytes(media.url);
        const fileName = decodeURIComponent(new URL(media.url).pathname.split("/").pop() || (media.type === "video" ? "video.mp4" : "photo.jpg"));
        const fields = { chat_id: String(chat), caption: entry.text, parse_mode: "HTML", ...(media.type === "video" ? { supports_streaming: "true" } : {}), ...(buttons.reply_markup ? { reply_markup: buttons.reply_markup } : {}) };
        res = await tgUpload(method, fields, field, { buffer, name: fileName });
      } catch (e) {
        return { ok: false, error: `файл не скачался для отправки байтами: ${e.message}`, retry: true };
      }
    }
  }

  if (res.kind !== "ok") return { ok: false, error: res.error, retry: res.kind === "network" };
  return { ok: true, id: String(res.result?.message_id || ""), link: linkOf(res.result) };
}

/**
 * Просмотры постов с веб-витрины канала. Канал должен быть публичным.
 * @param {Array<{ externalId: string }>} items externalId — номер сообщения
 */
export async function metrics(items) {
  const handle = String(channelId()).replace(/^@/, "");
  if (!handle || /^-?\d+$/.test(handle)) return items.map((i) => ({ externalId: i.externalId, error: "у закрытого канала витрины нет: просмотры снимаются руками", kind: "refused" }));
  const wanted = new Set(items.map((i) => String(i.externalId)));
  const found = new Map();
  let before = "";
  for (let page = 0; page < 6 && found.size < wanted.size; page++) {
    const r = await request(`https://t.me/s/${handle}${before ? `?before=${before}` : ""}`, { headers: { "user-agent": "Mozilla/5.0" }, retries: 1 });
    if (r.kind !== "ok" && !r.text) break;
    const blocks = r.text.split('<div class="tgme_widget_message_wrap').slice(1);
    if (!blocks.length) break;
    let min = Infinity;
    for (const b of blocks) {
      const id = b.match(/data-post="[^"\/]+\/(\d+)"/)?.[1];
      if (!id) continue;
      min = Math.min(min, Number(id));
      const views = b.match(/tgme_widget_message_views">([^<]+)</)?.[1] || "";
      if (wanted.has(id)) found.set(id, parseViews(views));
    }
    if (!Number.isFinite(min) || min <= 1) break;
    before = String(min);
    await sleep(800);
  }
  return items.map((i) => (found.has(String(i.externalId)) ? { externalId: i.externalId, views: found.get(String(i.externalId)) } : { externalId: i.externalId, error: "пост не найден на витрине", kind: "refused" }));
}

/** «1.2K» → 1200, «3.4M» → 3400000. */
export function parseViews(s) {
  const m = String(s).trim().match(/^([\d.,]+)\s*([KkMmКкМм])?$/u);
  if (!m) return 0;
  const n = Number(m[1].replace(",", "."));
  const mult = /[KkКк]/u.test(m[2] || "") ? 1e3 : /[MmМм]/u.test(m[2] || "") ? 1e6 : 1;
  return Math.round(n * mult);
}

/** Подписчики канала: для недельного отчёта. */
export async function followers() {
  const chat = channelId();
  if (!chat) return null;
  const r = await tg("getChatMemberCount", { chat_id: chat });
  return r.kind === "ok" && Number.isFinite(r.result) ? r.result : null;
}

/** Проверка для doctor: бот видит канал и имеет право публиковать. */
export async function probe() {
  const chat = channelId();
  if (!chat) return { kind: "refused", error: "нет TG_CHANNEL" };
  const me = await tg("getMe");
  if (me.kind !== "ok") return me;
  const member = await tg("getChatMember", { chat_id: chat, user_id: me.result.id });
  if (member.kind !== "ok") return member;
  const st = member.result?.status;
  if (st !== "administrator" && st !== "creator") return { kind: "refused", error: `бот в канале не администратор (статус ${st})` };
  if (member.result?.can_post_messages === false) return { kind: "refused", error: "у бота нет права публиковать сообщения" };
  return { kind: "ok", detail: `бот @${me.result.username} администратор канала` };
}
