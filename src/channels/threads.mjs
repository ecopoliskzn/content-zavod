// Threads: выпуск ветки, сверка с площадкой, цифры.
//
// СТАТУС: логика перенесена из двух наших боевых проектов (выпуск с сервера с 03.10.2026).
// За каждой паузой здесь стоит потерянная ветка:
//  · параметры уходят ФОРМОЙ, не JSON: JSON площадка молча теряет;
//  · между созданием контейнера и публикацией пауза: 3 с для текста, 25 с для картинки.
//    Сразу после создания площадка отвечает «resource does not exist»;
//  · ошибка публикации ещё не значит, что реплика не вышла: 26.09.2026 площадка ответила
//    «unexpected error, retry later», а пост стоял в ленте. Сначала ищем его на площадке;
//  · картинку Meta забирает сама и через раз отвечает «Media download has failed»:
//    между попытками минута, попыток до восьми. С сайта она файл не берёт вовсе, только
//    из публичного хранилища;
//  · номер каждой вышедшей реплики сразу отдаётся наружу (onStep): оборванную ветку
//    можно запустить ещё раз, и она продолжит с места обрыва без дублей;
//  · частое чтение обсуждений закрывало серверу доступ (код 80016, 07.10.2026):
//    цифры снимаем раз в сутки, обсуждения читаем не чаще раза в час.
//
// Сервер в России до graph.threads.net дотягивается напрямую, релей не нужен.

import { env } from "../lib/env.mjs";
import { form, request, sleep as realSleep } from "../lib/http.mjs";

export const name = "threads";
const API = "https://graph.threads.net/v1.0";

const token = () => env("THREADS_TOKEN");
const withToken = (url) => `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token())}`;

async function get(pathAndQuery, retries = 2) {
  return request(withToken(`${API}/${pathAndQuery}`), { retries, retryDelayMs: 15_000 });
}
async function post(path, body, retries = 2) {
  return request(`${API}/${path}`, { ...form({ ...body, access_token: token() }), retries, retryDelayMs: 15_000 });
}

/** Кто мы: id и имя аккаунта. Заодно проверка ключа для doctor. */
export async function me() {
  if (!token()) return { kind: "refused", error: "нет THREADS_TOKEN" };
  const r = await get("me?fields=id,username");
  return r.kind === "ok" ? { kind: "ok", id: r.data.id, username: r.data.username } : r;
}

/**
 * Выпускает реплики ветки начиная с первой невышедшей.
 * @param {{ posts: string[], media?: Array<{type:string,url:string}>, done?: string[], result?: {link?:string} }} entry
 * @param {{ onStep?: (done: string[], link?: string) => Promise<void>, verify?: boolean, sleep?: (ms:number)=>Promise<void> }} ctx
 * @returns {Promise<{ ok: boolean, id?: string, link?: string, done: string[], error?: string, retry?: boolean }>}
 */
export async function publish(entry, ctx = {}) {
  const sleep = ctx.sleep || realSleep;
  const done = [...(entry.done || [])];
  let link = entry.result?.link;
  const who = await me();
  if (who.kind !== "ok") return { ok: false, done, link, error: `профиль Threads не отвечает: ${who.error}`, retry: who.kind === "network" };
  const uid = who.id;

  // Ищем реплику там, где она должна появиться: корень в ленте профиля, ответ под родителем.
  const find = async (parent, start) => {
    const r = parent ? await get(`${parent}/replies?fields=id,text`, 0) : await get(`${uid}/threads?fields=id,text&limit=10`, 0);
    return (r.data?.data || []).find((x) => (x.text || "").trim().startsWith(start))?.id || null;
  };

  const one = async (text, parent, start, image, createAttempts) => {
    const body = image ? { media_type: "IMAGE", image_url: image, text } : { media_type: "TEXT", text };
    if (parent) body.reply_to_id = parent;
    let created = { kind: "network", error: "не начато" };
    for (let attempt = 1; attempt <= createAttempts; attempt++) {
      if (attempt > 1) await sleep(70_000);
      created = await post(`${uid}/threads`, body);
      if (created.kind === "ok" && created.data?.id) break;
      if (created.kind === "refused" && !image) break; // текст отклонён по правилу: повтор не поможет
    }
    if (!(created.kind === "ok" && created.data?.id)) return { error: `площадка не приняла текст: ${created.error}`, retry: created.kind === "network" };
    await sleep(image ? 25_000 : 3_000);

    let published = { kind: "network", error: "не начато" };
    for (let attempt = 1; attempt <= 3; attempt++) {
      published = await post(`${uid}/threads_publish`, { creation_id: created.data.id }, 0);
      if (published.kind === "ok" && published.data?.id) return { id: published.data.id };
      await sleep(20_000);
      const found = await find(parent, start);
      if (found) return { id: found };
    }
    return { error: `не опубликована: ${published.error}`, retry: true };
  };

  const posts = entry.posts || [];
  for (let i = done.length; i < posts.length; i++) {
    const text = posts[i];
    const parent = i === 0 ? null : done[i - 1];
    const start = text.slice(0, 60);
    let id = ctx.verify ? await find(parent, start) : null;
    if (!id) {
      const image = i === 0 ? entry.media?.find((m) => m.type === "image")?.url || null : null;
      const res = await one(text, parent, start, image, image ? 8 : 1);
      if (!res.id) return { ok: false, done, link, error: `реплика ${i + 1} из ${posts.length}: ${res.error}`, retry: res.retry };
      id = res.id;
    }
    done.push(id);
    if (i === 0) {
      const p = await get(`${id}?fields=permalink`, 1);
      link = p.data?.permalink || link;
    }
    if (ctx.onStep) await ctx.onStep([...done], link);
    if (i < posts.length - 1) await sleep(2_500);
  }
  return { ok: true, id: done[0], link, done };
}

/**
 * Цифры веток по номерам корневых реплик.
 * Ответы площадка считает вместе с нашими же репликами ветки: вычитаем свои (ownReplies).
 * @param {Array<{ externalId: string, ownReplies?: number }>} items
 */
export async function metrics(items) {
  const out = [];
  for (const item of items) {
    const r = await get(`${item.externalId}/insights?metric=views,likes,replies,reposts,quotes`, 1);
    if (r.kind !== "ok") { out.push({ externalId: item.externalId, error: r.error, kind: r.kind }); continue; }
    const row = { externalId: item.externalId };
    for (const m of r.data?.data || []) row[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
    row.replies = Math.max(0, (row.replies || 0) - (item.ownReplies || 0));
    out.push(row);
    await realSleep(400);
  }
  return out;
}

/** Подписчики аккаунта: для вечерней сводки и недельного отчёта. */
export async function followers() {
  const who = await me();
  if (who.kind !== "ok") return null;
  const r = await get(`${who.id}/threads_insights?metric=followers_count`, 1);
  const m = (r.data?.data || []).find((x) => x.name === "followers_count");
  return m?.total_value?.value ?? null;
}

/** Срок маркера и продление. Маркер живёт 60 дней, не продлённый вовремя умирает безвозвратно. */
export async function refreshToken() {
  const r = await request(`${API.replace("/v1.0", "")}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token())}`, { retries: 1 });
  if (r.kind !== "ok" || !r.data?.access_token) return { kind: r.kind === "ok" ? "refused" : r.kind, error: r.error || "площадка не вернула новый маркер" };
  return { kind: "ok", token: r.data.access_token, expiresInSec: Number(r.data.expires_in) || 0 };
}
