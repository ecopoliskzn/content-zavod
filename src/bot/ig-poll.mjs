#!/usr/bin/env node
// Запасной путь для кодовых слов в комментариях Instagram: опрос вместо вебхука.
//
// ЗАЧЕМ. Первый месяц аккаунт клиента работает через приложение Meta исполнителя в роли
// тестировщика. В нашем прошлом запуске тестовый комментарий с кодовым словом в таком
// режиме до вебхука не дошёл: событиям о комментариях Meta может требовать расширенный
// доступ приложения. Сообщения в директ при этом приходили. Поэтому комментарии умеют
// читаться и опросом: раз в пять минут сервер смотрит свежие публикации и забирает
// новые комментарии сам. Вебхук заработал — опрос выключается одной переменной.
//
//   IG_POLL=1 в окружении сервера, cron:
//   */5 * * * * node /opt/ecopolis-zavod/current/src/bot/ig-poll.mjs
//
// ЧТОБЫ НЕ НАВРЕДИТЬ:
//  · первый проход только запоминает то, что уже есть: на старые комментарии бот не
//    отвечает. Ответ через месяц на «+» под давним роликом выглядит как сбой;
//  · комментарии читаются только у публикаций, где счётчик комментариев вырос: это один
//    вызов на проход вместо двенадцати. Частое чтение площадки закрывают;
//  · событие кладётся в ту же очередь, что и события вебхука, с тем же номером. Если
//    вебхук всё-таки доставил этот комментарий, второй раз человеку не ответят;
//  · свои комментарии и ответы аккаунта пропускаются.
//
// Запуск руками:  node src/bot/ig-poll.mjs [--dry]

import { fileURLToPath } from "node:url";
import { dataPath, env } from "../lib/env.mjs";
import { readJson, writeJson } from "../lib/files.mjs";
import { ig, igUserId } from "../lib/ig.mjs";
import { drain } from "./ig-flow.mjs";
import { bot } from "./instance.mjs";

const STATE = () => dataPath("leads", "ig-poll.json");
const MEDIA_LIMIT = 12;
const MAX_AGE_DAYS = 30;
const KEEP_SEEN = 400;

/**
 * Комментарий площадки → событие очереди. Чистая функция.
 * Возвращает null для своих комментариев и пустых.
 */
export function toEvent(comment, mediaId, ownId, ownUsername, now = new Date()) {
  const id = String(comment?.id || "");
  const text = String(comment?.text || "").trim();
  if (!id || !text) return null;
  const fromId = String(comment.from?.id || "");
  const username = String(comment.from?.username || comment.username || "");
  if ((ownId && fromId === String(ownId)) || (ownUsername && username.toLowerCase() === String(ownUsername).toLowerCase())) return null;
  return { id: `com-${id}`, вид: "комментарий", текст: text, отId: fromId, отИмя: username, когда: comment.timestamp ? new Date(comment.timestamp).toISOString() : now.toISOString(), пост: String(mediaId), принято: now.toISOString(), путь: "опрос" };
}

/**
 * Какие публикации перечитать и какие комментарии новые. Чистая функция состояния.
 * @param {{ media: Record<string, { count: number, seen: string[] }>, primed?: boolean }} state
 */
export function plan(state, mediaList, now = Date.now()) {
  const next = { primed: state.primed ?? false, media: { ...(state.media || {}) } };
  const toRead = [];
  for (const m of mediaList) {
    const age = (now - Date.parse(m.timestamp || 0)) / 86_400_000;
    if (!(age <= MAX_AGE_DAYS)) continue;
    const was = next.media[m.id];
    const count = Number(m.comments_count) || 0;
    if (!was) {
      // Новая публикация: читаем, если комментарии уже есть. Вышла между проходами —
      // её комментарии новые и ответа заслуживают (если состояние уже заведено).
      next.media[m.id] = { count: 0, seen: [] };
      if (count > 0) toRead.push(m.id);
    } else if (count > was.count) {
      toRead.push(m.id);
    }
  }
  // Публикации, выпавшие из окна, забываем: файл состояния не должен расти.
  const alive = new Set(mediaList.map((m) => m.id));
  for (const id of Object.keys(next.media)) if (!alive.has(id)) delete next.media[id];
  return { next, toRead };
}

export async function poll({ dry = false } = {}) {
  if (env("IG_POLL") !== "1" && !dry) return { skipped: "IG_POLL не включён" };
  const uid = igUserId();
  if (!uid) return { error: "нет IG_USER_ID" };
  const feed = await ig(`${uid}/media?fields=id,timestamp,comments_count&limit=${MEDIA_LIMIT}`, { retries: 0 });
  if (feed.kind !== "ok") return { error: `лента не прочиталась (${feed.kind}): ${feed.error}` };
  const state = readJson(STATE(), { media: {}, primed: false }) || { media: {}, primed: false };
  const { next, toRead } = plan(state, feed.data?.data || []);
  const b = bot();
  const ownUsername = env("IG_USERNAME");
  let fresh = 0;

  for (const mediaId of toRead) {
    const r = await ig(`${mediaId}/comments?fields=id,text,username,timestamp,from&limit=50`, { retries: 0 });
    if (r.kind !== "ok") continue; // прочитаем в следующий проход: счётчик не обновляем
    const comments = r.data?.data || [];
    const slot = next.media[mediaId];
    const seen = new Set(slot.seen);
    for (const c of comments) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      // Первый проход только запоминает: отвечать на накопленное за месяцы нельзя.
      if (!state.primed) continue;
      const event = toEvent(c, mediaId, uid, ownUsername);
      if (!event) continue;
      fresh++;
      if (!dry) b.ig.queue["положить"](event);
    }
    slot.seen = [...seen].slice(-KEEP_SEEN);
    slot.count = Number((feed.data?.data || []).find((m) => m.id === mediaId)?.comments_count) || comments.length;
  }
  next.primed = true;
  if (!dry) {
    writeJson(STATE(), next);
    writeJson(dataPath("heartbeat.json"), { ...(readJson(dataPath("heartbeat.json"), {}) || {}), igPoll: new Date().toISOString() });
  }
  const drained = !dry && fresh ? await drain(b) : { handled: 0, replied: 0 };
  return { read: toRead.length, fresh, replied: drained.replied, primed: state.primed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  poll({ dry: process.argv.includes("--dry") }).then(
    (r) => {
      if (r.error) { console.error(`${new Date().toISOString()} опрос Instagram: ${r.error}`); process.exitCode = 2; return; }
      if (r.skipped || (!r.fresh && r.primed)) return; // тихий проход в журнал не пишем
      console.log(`${new Date().toISOString()} опрос Instagram: ${JSON.stringify(r)}`);
    },
    (e) => { console.error(`сбой опроса Instagram: ${e?.stack || e}`); process.exitCode = 2; },
  );
}
