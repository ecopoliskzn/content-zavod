// Рассылка в чат-боте: сообщение тем, кто дал отдельное согласие на рассылку.
//
// Для очереди это такая же площадка, как остальные: запись проходит проверки и ждёт
// «Одобрить» от человека клиента. Отличие в том, кому уходит текст: не подписчикам
// канала, а каждому согласившемуся лично.
//
// ПРАВИЛА (каждое записано в тексте согласия, которое человек видел):
//  · только тем, у кого согласие на рассылку дано и не отозвано;
//  · не чаще двух рассылок за 30 дней. Третью площадка не выпустит;
//  · в конце каждого сообщения способ отказаться: /stop;
//  · содержание как в Telegram-канале: бот живёт в Telegram, поэтому проверка рекламы
//    для него та же. Материал и приглашение прочитать, без цен и призывов купить.
//
// ПОВТОР БЕЗОПАСЕН. Кому сообщение уже ушло, записывается в журнал рассылки до отправки
// следующему. Оборвалась на середине — повторный проход продолжит с того же места и
// никому не отправит дважды.
//
// СЕТЕВОЙ СБОЙ НА ОДНОМ ЧЕЛОВЕКЕ. Дошло ли сообщение, после обрыва неизвестно. Людям
// обещано не больше двух сообщений в месяц, поэтому из двух ошибок выбрана меньшая:
// такому человеку рассылка не повторяется, а в итоге он посчитан как «не подтверждено».
// Внутреннего повтора у отправки нет по той же причине.
//
// Человек, заблокировавший бота, помечается и из следующих рассылок исключается: бот,
// который стучится к заблокировавшим, быстро получает ограничения от Telegram.

import { dataPath } from "../lib/env.mjs";
import { appendJsonl, readJsonl } from "../lib/files.mjs";
import { sleep as realSleep } from "../lib/http.mjs";
import { keyboard, tg } from "../lib/telegram.mjs";
import { bot } from "../bot/instance.mjs";
import { published } from "../queue/ledger.mjs";

export const name = "bot";
const MONTH_LIMIT = 2;
const FOOTER = "\n\n<i>Отказаться от сообщений: /stop</i>";

const logFile = (id) => dataPath("leads", `broadcast-${id}.jsonl`);
// Сбои, при которых запрос до Telegram не дошёл вовсе: соединения не было.
const NOT_SENT = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH/;

/** Кому можно писать: согласие дано, бот не остановлен и не заблокирован. Чистая функция. */
export function recipients(subscribers) {
  return subscribers.filter((s) => s.adsConsent === true && s.status !== "stopped" && s.status !== "blocked");
}

/** @param {{ id: string, text: string, media?: any[], buttons?: any[][] }} entry */
export async function publish(entry, ctx = {}) {
  const sleep = ctx.sleep || realSleep;
  if ((entry.media || []).length) return { ok: false, retry: false, error: "рассылка идёт текстом с кнопкой: вложения не поддерживаются" };
  const recent = published({ sinceMs: Date.now() - 30 * 86_400_000, channel: name }).filter((r) => r.id !== entry.id);
  if (recent.length >= MONTH_LIMIT) return { ok: false, retry: false, error: `за последние 30 дней рассылок уже ${recent.length}. В согласии людям обещано не больше ${MONTH_LIMIT} в месяц` };

  const b = bot();
  const list = recipients(await b.telegram.store.readSubscribers());
  if (!list.length) return { ok: false, retry: false, error: "согласие на рассылку пока не дал никто: отправлять некому" };

  const already = new Set(readJsonl(logFile(entry.id)).map((r) => String(r.user)));
  const text = entry.text.includes("/stop") ? entry.text : entry.text + FOOTER;
  const extra = { parse_mode: "HTML", link_preview_options: { is_disabled: false }, ...(entry.buttons?.length ? keyboard(entry.buttons) : {}) };
  let sent = 0;
  let blocked = 0;
  let network = 0;
  for (const s of list) {
    if (already.has(String(s.id))) continue;
    const res = await tg("sendMessage", { chat_id: s.id, text, ...extra }, { retries: 0 });
    if (res.kind === "ok") {
      appendJsonl(logFile(entry.id), { user: String(s.id), at: new Date().toISOString() });
      sent++;
    } else if (res.kind === "refused") {
      // Заблокировал бота, удалил аккаунт: больше не пишем.
      appendJsonl(logFile(entry.id), { user: String(s.id), at: new Date().toISOString(), refused: String(res.error || "").slice(0, 80) });
      if (/blocked|deactivated|chat not found|user is deactivated/i.test(res.error || "")) await b.telegram.store.upsertSubscriber(String(s.id), { status: "blocked" });
      blocked++;
    } else {
      /* Обрыв: могло дойти, могло нет. Второй раз этому человеку не шлём. Исключение —
         сбой, при котором сообщение точно не ушло: соединение не установилось либо
         Telegram попросил притормозить (429). Таких людей повтор рассылки найдёт сам. */
      const notSent = res.status === 429 || NOT_SENT.test(res.error || "");
      if (!notSent) appendJsonl(logFile(entry.id), { user: String(s.id), at: new Date().toISOString(), unsure: true });
      if (++network >= 5 || res.status === 429) {
        const rows = readJsonl(logFile(entry.id));
        const left = list.filter((x) => !rows.some((r) => String(r.user) === String(x.id))).length;
        return { ok: false, retry: true, error: `связь с Telegram рвётся: доставлено ${rows.filter((r) => !r.refused && !r.unsure).length}, не подтверждено ${rows.filter((r) => r.unsure).length}, осталось ${left}. Повтор продолжит с этого места` };
      }
    }
    await sleep(70); // предел Bot API — около 30 сообщений в секунду, идём вдвое медленнее
  }
  const rows = readJsonl(logFile(entry.id));
  const delivered = rows.filter((r) => !r.refused && !r.unsure).length;
  const unsure = rows.filter((r) => r.unsure).length;
  return { ok: true, id: `bot-${entry.id}`, link: "", note: `рассылка: доставлено ${delivered} из ${list.length}${blocked ? `, недоступны ${blocked}` : ""}${unsure ? `, не подтверждено ${unsure}` : ""}` };
}

/** «Просмотры» рассылки — число доставленных сообщений. */
export async function metrics(items) {
  return items.map((i) => {
    const id = String(i.externalId).replace(/^bot-/, "");
    const rows = readJsonl(logFile(id));
    return { externalId: i.externalId, views: rows.filter((r) => !r.refused && !r.unsure).length, refused: rows.filter((r) => r.refused).length };
  });
}

/** Сколько людей согласились на рассылку: для недельного отчёта. */
export async function followers() {
  return recipients(await bot().telegram.store.readSubscribers()).length;
}

export async function probe() {
  const me = await tg("getMe");
  if (me.kind !== "ok") return me;
  return { kind: "ok", detail: `бот @${me.result.username}, согласий на рассылку: ${await followers()}` };
}
