// Счётчик переходов: короткая ссылка на своём адресе, которая считает клик и ведёт дальше.
//
// ЗАЧЕМ. Счётчики на сайте клиента ведут другие подрядчики, и доступ к ним может не
// появиться вовсе. Поэтому переходы считаем сами: каждая ссылка из поста идёт через
// /go/<слаг>?c=<площадка>&p=<номер записи>, сервер пишет строку в журнал и отправляет
// человека на страницу сайта с метками utm. Когда доступ к Метрике появится, те же
// метки будут видны и там, и цифры можно будет сверить.
//
// ЧТО ПИШЕМ. Время, слаг, площадку, номер записи, вид устройства и обезличенный след
// посетителя (хеш с суточной солью, по нему не восстановить ни адрес, ни человека).
// IP-адрес в журнал не попадает. Роботы, которые рисуют превью ссылки, считаются отдельно:
// иначе каждый пост «получает» десяток переходов в первую же минуту.
//
// Слаги и адреса лежат в bot/links.json. Неизвестный слаг ведёт на главную сайта и
// тоже пишется в журнал: так видно опечатку в ссылке, а человек не упирается в ошибку.

import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../lib/config.mjs";
import { PROJECT_ROOT, dataPath } from "../lib/env.mjs";
import { appendJsonl, readJson, readJsonl, writeJson } from "../lib/files.mjs";
import { mskDate } from "../lib/time.mjs";

const LINKS = path.join(PROJECT_ROOT, "bot", "links.json");
const CLICKS = () => dataPath("go-clicks.jsonl");
const BOTS = /bot|crawler|spider|preview|facebookexternalhit|vkshare|whatsapp|telegram|slack|discord|curl|wget|python-requests|okhttp|headless/i;

function salt() {
  const file = dataPath("go-salt.json");
  const day = mskDate();
  const s = readJson(file, {}) || {};
  if (s.day !== day) {
    const next = { day, salt: randomBytes(16).toString("hex") };
    writeJson(file, next);
    return next.salt;
  }
  return s.salt;
}

/** Куда вести и с какими метками. Чистая функция. */
export function target(slug, query, links, siteRoot) {
  const link = links?.[slug];
  const base = link?.url || siteRoot;
  const u = new URL(base);
  const c = String(query.c || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 24);
  const p = String(query.p || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 32);
  if (!u.searchParams.has("utm_source")) {
    u.searchParams.set("utm_source", c || "zavod");
    u.searchParams.set("utm_medium", c.startsWith("bot") ? "bot" : "social");
    u.searchParams.set("utm_campaign", slug);
    if (p) u.searchParams.set("utm_content", p);
  }
  return { url: u.toString(), known: Boolean(link), c, p };
}

/**
 * Обработчик GET /go/<слаг>. Возвращает { status, headers }.
 * @param {URL} url
 * @param {{ headers: Record<string, string | string[] | undefined>, socket?: { remoteAddress?: string } }} req
 */
export function handleGo(url, req) {
  const slug = decodeURIComponent(url.pathname.replace(/^\/go\//, "").split("/")[0] || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const links = readJson(LINKS, {}) || {};
  const t = target(slug, Object.fromEntries(url.searchParams), links, config().client.site);
  const ua = String(req.headers["user-agent"] || "");
  const ip = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  appendJsonl(CLICKS(), {
    at: new Date().toISOString(),
    slug,
    known: t.known,
    c: t.c,
    p: t.p,
    device: BOTS.test(ua) || !ua ? "robot" : /mobile|android|iphone/i.test(ua) ? "mobile" : "desktop",
    ref: (() => { try { return new URL(String(req.headers.referer || "")).host; } catch { return ""; } })(),
    v: createHash("sha256").update(`${salt()}|${ip}|${ua}`).digest("hex").slice(0, 10),
  });
  return { status: 302, headers: { location: t.url, "cache-control": "no-store", "referrer-policy": "no-referrer-when-downgrade" } };
}

/**
 * Сводка переходов за период: по площадкам и по записям. Роботы не считаются.
 * @returns {{ total: number, unique: number, byChannel: Record<string, number>, byPost: Record<string, number>, bySlug: Record<string, number> }}
 */
export function clickStats(sinceMs = 0, untilMs = Date.now()) {
  const rows = readJsonl(CLICKS()).filter((r) => r.device !== "robot" && Date.parse(r.at) >= sinceMs && Date.parse(r.at) <= untilMs);
  const count = (key) => rows.reduce((acc, r) => { const k = r[key] || "без метки"; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  return { total: rows.length, unique: new Set(rows.map((r) => r.v)).size, byChannel: count("c"), byPost: count("p"), bySlug: count("slug") };
}
