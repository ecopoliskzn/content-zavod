// Instagram: кодовое слово в комментарии или в директе → личное сообщение с материалом.
//
// СТАТУС: порядок действий перенесён из двух наших боевых ботов.
//
// Как идёт событие. Meta шлёт его на вебхук приложения. Первый месяц приложение
// принадлежит исполнителю: его сайт видит, что событие чужого аккаунта, и пересылает
// сюда. Сервер складывает событие в очередь и отвечает 200 сразу, а отправка идёт
// отдельным шагом через релей: graph.instagram.com с сервера в России не отвечает.
//
// Грабли, за которые уже заплачено:
//  · вебхук ВСЕГДА отвечает 200. По любому другому коду Meta повторяет событие всё чаще,
//    а после нескольких неудач отключает подписку вовсе;
//  · своё эхо отсекается: сообщение, отправленное нами, приходит обратно как входящее;
//  · слово ищется отдельным словом и с пределом длины сообщения. Поиск «вхождением» без
//    предела у нас пять раз ответил в чужой разговор;
//  · запись в журнал делается ДО публичного ответа под комментарием, иначе при сбое
//    человек получает ответ дважды;
//  · подписка аккаунта на события — отдельный вызов, и она слетает при перевыпуске
//    маркера. Маркер живой, вебхук настроен, а событий нет: это она;
//  · личный ответ на комментарий можно отправить один раз и в течение семи суток.
//    Дальше писать человеку можно только в сутки после его последнего сообщения;
//  · ссылки в комментариях Instagram не нажимаются. Ссылка уходит только в директ.
//
// ЧТО ПИШЕМ. Публичный ответ под комментарием нейтрален: «Отправили в личные сообщения».
// Материал и ссылка идут в директ. Это личная переписка с тем, кто сам попросил, а не
// сообщение неопределённому кругу лиц.

import { dataPath, has } from "../lib/env.mjs";
import { appendJsonl, readJsonl } from "../lib/files.mjs";
import { ig } from "../lib/ig.mjs";
import { legalReady } from "../leads/legal.mjs";
import { bot } from "./instance.mjs";

const rawId = (eventId) => String(eventId || "").replace(/^(com|msg)-/, "");
const SENT = () => dataPath("leads", "ig-sent.jsonl");

/**
 * Собирает ответ по событию, ничего не отправляя. Чистая функция, удобная для тестов.
 * @returns {null | { recipient: object, text: string, publicReply?: string, scenario: string, personalKey: string, word: string }}
 */
export function buildReply(b, event) {
  const where = event["вид"] === "комментарий" ? "комментарий" : "директ";
  const match = b.ig["подобрать"](event["текст"], where);
  if (!match) return null;
  const scenario = match["сценарий"];
  if (scenario["включён"] === false) return null;
  // Слово внутри длинной реплики — это разговор, а не просьба прислать материал.
  const limit = Number(scenario["максДлина"]) || 0;
  if (limit && match["вид"] !== "точное" && String(event["текст"] || "").trim().length > limit) return null;
  // Метка несёт канал («ig-»), слово и номер человека в Instagram: по ней бот в Telegram
  // понимает, откуда человек пришёл и что просил, а событие Instagram склеивается с заявкой.
  const personalKey = b.ig["персональнаяМетка"](`ig-${scenario["ключ"]}`, event["отId"]);
  const link = b.telegram.botLink(personalKey);
  const text = b.ig["подставить"](scenario["текст"], { ссылка: link, слово: match["слово"] });
  const recipient = event["вид"] === "комментарий" ? { comment_id: rawId(event.id) } : { id: event["отId"] };
  return { recipient, text, publicReply: event["вид"] === "комментарий" ? scenario["публично"] : undefined, scenario: scenario["ключ"], personalKey, word: match["слово"] };
}

/** Разбирает очередь событий один раз. Возвращает, сколько обработано и сколько ответов ушло. */
export async function drain(b = bot()) {
  // Тексты согласий не утверждены: на слова не отвечаем. Очередь при этом и не наполняется
  // (вебхук и опрос закрыты тем же заслоном), проверка здесь стоит на случай старых событий.
  if (!legalReady()) return { handled: 0, replied: 0, closed: true };
  const events = b.ig.queue["взять"]();
  const handled = [];
  let replied = 0;
  const already = new Set(readJsonl(SENT()).map((r) => r.event));
  for (const event of events) {
    handled.push(event.id);
    if (already.has(event.id)) continue; // событие пришло повторно: второй раз не отвечаем
    try {
      const reply = buildReply(b, event);
      if (!reply || !has("IG_TOKEN")) continue;
      // Журнал — до отправки: при сбое посередине лучше промолчать, чем ответить дважды.
      appendJsonl(SENT(), { at: new Date().toISOString(), event: event.id, kind: event["вид"], scenario: reply.scenario, word: reply.word });
      // Без повторов: повтор отправки после таймаута — это второе сообщение человеку.
      const dm = await ig("me/messages", { method: "POST", body: { recipient: reply.recipient, message: { text: reply.text } }, retries: 0 });
      if (dm.kind !== "ok") {
        console.error(`[ig] директ не ушёл (${dm.kind}): ${dm.error}`);
        appendJsonl(SENT(), { at: new Date().toISOString(), event: event.id, failed: true, kind: dm.kind, error: String(dm.error || "").slice(0, 200) });
        continue;
      }
      replied++;
      if (reply.publicReply) {
        await ig(`${rawId(event.id)}/replies`, { method: "POST", body: { message: reply.publicReply }, retries: 0 });
      }
    } catch (e) {
      console.error("[ig] сбой обработки события", event.id, e?.message || e);
    }
  }
  if (handled.length) b.ig.queue["убрать"](handled);
  return { handled: handled.length, replied };
}

/** Сколько раз за период сработало каждое слово: для сводки и недельного отчёта. */
export function keywordStats(sinceMs = 0) {
  const out = {};
  for (const r of readJsonl(SENT())) {
    if (r.failed || !r.scenario || Date.parse(r.at) < sinceMs) continue;
    out[r.scenario] = (out[r.scenario] || 0) + 1;
  }
  return out;
}
