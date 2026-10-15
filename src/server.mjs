#!/usr/bin/env node
// Сервер завода: один процесс на обычном node:http, без сборки и тяжёлых зависимостей.
//
//   GET  /health            живость, какие ключи заданы (без значений), когда был выпуск
//   POST /tg/update         обновления Telegram от релея (заголовок-секрет)
//   GET  /ig/webhook        подтверждение подписки Meta (после переезда на своё приложение)
//   POST /ig/webhook        события Instagram: приходят после переезда на своё приложение
//   POST /admin/queue       команды очереди с компьютера оператора (ключ ADMIN_API_TOKEN)
//   GET  /go/<слаг>         счётчик переходов и переадресация на сайт клиента
//   GET  /z/<слаг>          форма заявки; POST туда же — приём
//   GET  /cb/vk, /cb/meta   страница возврата после входа владельца аккаунта: показывает код
//   GET  /doc/<имя>         тексты согласий и политики из каталога legal/site
//
// За nginx с HTTPS. Сам процесс слушает только 127.0.0.1.
// Выпуск по расписанию сюда не входит: его зовёт cron отдельным процессом (runner.mjs),
// чтобы перезапуск сервера не обрывал выходящую ветку.

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT, dataPath, env, has, num } from "./lib/env.mjs";
import { readJson, writeJson } from "./lib/files.mjs";
import { groupId } from "./lib/notify.mjs";
import * as approval from "./bot/approval.mjs";
import * as customer from "./bot/customer.mjs";
import { drain } from "./bot/ig-flow.mjs";
import { bot } from "./bot/instance.mjs";
import * as leads from "./bot/leads.mjs";
import * as staff from "./bot/staff.mjs";
import { handleGo } from "./leads/go.mjs";
import { renderForm, submitForm } from "./leads/form.mjs";
import { legalReady } from "./leads/legal.mjs";
import { execute } from "./queue/commands.mjs";
import { appPage } from "./app-pages.mjs";

const send = (res, status, body, headers = {}) => {
  const isObject = typeof body === "object" && body !== null;
  res.writeHead(status, { "content-type": isObject ? "application/json; charset=utf-8" : "text/html; charset=utf-8", "x-content-type-options": "nosniff", ...headers });
  res.end(isObject ? JSON.stringify(body) : body);
};

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("тело запроса слишком большое"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const same = (a, b) => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/**
 * Очень простой перевод markdown в страницу: заголовки, абзацы, списки, таблицы.
 * Для текстов согласий и политики; полный разбор разметки здесь не нужен.
 */
export function docHtml(markdown) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => esc(c.trim()));
  let title = "Документ";
  const html = String(markdown).replace(/\r\n?/g, "\n").split(/\n{2,}/).map((block) => {
    const b = block.trim();
    if (!b) return "";
    const h = b.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      if (h[1].length === 1) title = h[2];
      return `<h${h[1].length}>${esc(h[2])}</h${h[1].length}>`;
    }
    const lines = b.split("\n");
    if (lines.every((l) => /^[-*]\s/.test(l))) return `<ul>${lines.map((l) => `<li>${esc(l.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    if (lines.length > 1 && lines.every((l) => l.trim().startsWith("|"))) {
      const rows = lines.filter((l) => !/^\|?[\s:|-]+\|?$/.test(l.trim()));
      return `<table><thead><tr>${cells(rows[0]).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
    return `<p>${esc(b).replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:17px/1.6 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:28px 18px 60px;color:#1c1f1a}h1{font-size:26px;line-height:1.25;text-wrap:balance}h2{font-size:20px;margin-top:28px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #c9cec4;padding:8px 10px;text-align:left;vertical-align:top}th{background:#eef0ec}</style></head><body>${html}</body></html>`;
}

function docPage(name) {
  const file = path.join(PROJECT_ROOT, "legal", "site", `${name.replace(/[^a-z0-9-]/gi, "")}.md`);
  if (!existsSync(file)) return null;
  return docHtml(readFileSync(file, "utf8"));
}

/** Обновление Telegram: кнопка или сообщение, из рабочей группы или из личного чата. */
async function onTelegram(update) {
  const group = String(groupId());
  const cb = update.callback_query;
  if (cb) {
    if (await approval.handleCallback(cb)) return;
    if (await leads.handleCallback(cb)) return;
    if (await staff.handleCallback(cb)) return;
    await customer.handleCallback(cb);
    return;
  }
  const message = update.message;
  if (!message) return;
  if (String(message.chat?.id) === group) {
    if (await staff.handleCommand(message)) return;
    if (await approval.handleReply(message)) return;
    if (await staff.handlePackageReply(message)) return;
    await leads.handleGroupReply(message);
    return;
  }
  if (message.chat?.type === "private") await customer.handleMessage(message);
}

export function createHandler() {
  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (req.method === "GET" && p === "/health") {
      const beat = readJson(dataPath("heartbeat.json"), {}) || {};
      return send(res, 200, {
        ok: true,
        service: "ecopolis-zavod",
        runnerAt: beat.runner || null,
        igPollAt: beat.igPoll || null,
        stopped: existsSync(dataPath("STOP")),
        configured: Object.fromEntries(["TG_RELAY_URL", "TG_GROUP_ID", "TG_CHANNEL", "APPROVER_IDS", "THREADS_TOKEN", "IG_TOKEN", "IG_RELAY_URL", "VK_GROUP_TOKEN", "VK_USER_TOKEN", "YOUTUBE_REFRESH_TOKEN", "RUTUBE_TOKEN", "ADMIN_API_TOKEN", "PUBLIC_BASE_URL"].map((k) => [k, has(k)])),
      });
    }

    if (req.method === "POST" && p === "/tg/update") {
      if (!same(req.headers["x-telegram-bot-api-secret-token"], env("TG_WEBHOOK_SECRET"))) return send(res, 401, { ok: false });
      let update = {};
      try { update = JSON.parse(await readBody(req)); } catch { return send(res, 200, { ok: true }); }
      // Telegram важен только код 200: иначе обновление уйдёт в бесконечный повтор.
      send(res, 200, { ok: true });
      onTelegram(update).catch((e) => console.error("[tg] сбой обработки обновления:", e?.stack || e));
      return;
    }

    if (req.method === "GET" && p === "/ig/webhook") {
      const check = bot().ig.webhook["подтверждениеПодписки"]({ mode: url.searchParams.get("hub.mode"), token: url.searchParams.get("hub.verify_token"), challenge: url.searchParams.get("hub.challenge") });
      return check.ok ? send(res, 200, check.challenge, { "content-type": "text/plain" }) : send(res, 403, { ok: false });
    }

    if (req.method === "POST" && p === "/ig/webhook") {
      // Тело читаем сырым: подпись считается по байтам.
      const body = await readBody(req);
      const b = bot();
      // События подписывает Meta секретом своего приложения. Подпись парой
      // (IG_FORWARD_SECRET) оставлена на случай пересылки через чужой сервер; решением
      // владельца 10.10.2026 она не используется, и переменная пуста.
      const { ["подписьВерна"]: verify } = await import("#bot");
      const viaForward = env("IG_FORWARD_SECRET") && verify(body, req.headers["x-forward-signature"], env("IG_FORWARD_SECRET"));
      const viaMeta = env("IG_APP_SECRET") && verify(body, req.headers["x-hub-signature-256"], env("IG_APP_SECRET"));
      if (!viaForward && !viaMeta) return send(res, 401, { ok: false });
      // Согласия не утверждены: событие принято (Meta ждёт 200), но не записано и без ответа.
      if (!legalReady()) return send(res, 200, { ok: true, принято: 0 });
      const account = env("IG_USER_ID");
      const events = b.ig.webhook["разобратьСобытия"](body, { accountId: account || undefined });
      for (const event of events) b.ig.queue["положить"](event);
      // Meta ждёт 200 всегда: по другому коду она повторяет событие и в пределе отключает подписку.
      send(res, 200, { ok: true, принято: events.length });
      drain(b).catch((e) => console.error("[ig] сбой разбора очереди:", e?.stack || e));
      return;
    }

    if (req.method === "POST" && p === "/admin/queue") {
      const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!same(auth, env("ADMIN_API_TOKEN"))) return send(res, 401, { code: 2, lines: ["ключ оператора не подошёл"] });
      let payload;
      try { payload = JSON.parse(await readBody(req, 8 * 1024 * 1024)); } catch { return send(res, 400, { code: 2, lines: ["тело запроса не разобрано"] }); }
      return send(res, 200, await execute(String(payload.cmd || ""), payload.args || {}, String(payload.actor || "оператор").slice(0, 40)));
    }

    if (req.method === "GET" && p.startsWith("/go/")) {
      const out = handleGo(url, req);
      res.writeHead(out.status, out.headers);
      return res.end();
    }

    if (p.startsWith("/z/")) {
      const slug = p.slice(3).replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "zayavka";
      // Пока тексты согласий не утверждены, вместо формы стоит страница «скоро заработает».
      if (req.method === "GET") return send(res, legalReady() ? 200 : 503, renderForm(slug, Object.fromEntries(url.searchParams)));
      if (req.method === "POST") {
        const body = new URLSearchParams(await readBody(req, 64 * 1024));
        const ip = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
        const out = await submitForm(slug, body, { ip, ua: String(req.headers["user-agent"] || "") });
        return send(res, out.status, out.html);
      }
    }

    if (req.method === "GET" && p === "/cb/vk") {
      // Возврат после входа администратора ВКонтакте. Сервер ничего не сохраняет и ничего
      // не обменивает: он только показывает человеку две строки, которые тот передаст
      // оператору. Код одноразовый и живёт десять минут.
      const safe = (s) => String(s || "").replace(/[^\w.-]/g, "").slice(0, 400);
      const codeValue = safe(url.searchParams.get("code"));
      const device = safe(url.searchParams.get("device_id"));
      const body = codeValue
        ? `<h1>Вход выполнен</h1><p>Передайте оператору эти две строки. Код действует десять минут и годится один раз.</p><p><b>Код:</b><br><code>${codeValue}</code></p><p><b>Номер устройства:</b><br><code>${device}</code></p>`
        : `<h1>Вход не выполнен</h1><p>ВКонтакте не вернул код. Попросите у оператора новую ссылку.</p>`;
      return send(res, 200, `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Вход ВКонтакте</title><style>body{font:17px/1.6 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:28px 18px}code{word-break:break-all;background:#eef0ec;padding:4px 6px;border-radius:6px}</style></head><body>${body}</body></html>`, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
    }

    if (req.method === "GET" && p === "/cb/meta") {
      // Возврат после входа владельца в Instagram или Threads через СВОЁ приложение клиента
      // (со второго месяца). Как и у ВКонтакте: сервер ничего не сохраняет и не обменивает,
      // он показывает человеку код, который тот передаст оператору. Код живёт час.
      const codeValue = String(url.searchParams.get("code") || "").replace(/[^\w.-]/g, "").slice(0, 700);
      const body = codeValue
        ? `<h1>Вход выполнен</h1><p>Передайте оператору этот код. Он действует один час и годится один раз.</p><p><code>${codeValue}</code></p>`
        : `<h1>Вход не выполнен</h1><p>Площадка не вернула код. Попросите у оператора новую ссылку.</p>`;
      return send(res, 200, `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Вход</title><style>body{font:17px/1.6 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:28px 18px}code{word-break:break-all;background:#eef0ec;padding:4px 6px;border-radius:6px}</style></head><body>${body}</body></html>`, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
    }

    if (req.method === "GET" && (p === "/" || p.startsWith("/youtube-app"))) {
      const html = appPage(p === "/" ? "/youtube-app/" : p);
      if (html) return send(res, 200, html, { "cache-control": "no-cache", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
    }

    if (req.method === "GET" && p.startsWith("/doc/")) {
      const html = docPage(p.slice(5));
      return html ? send(res, 200, html) : send(res, 404, { ok: false });
    }

    return send(res, 404, { ok: false });
  };
}

export function startServer() {
  const handler = createHandler();
  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      console.error("[server] необработанная ошибка запроса:", e?.stack || e);
      if (!res.headersSent) send(res, e?.status || 500, { ok: false });
    });
  });
  // Очередь Instagram разбирается и по событию, и по таймеру: событие могло прийти, пока
  // релей не отвечал, и без таймера оно ждало бы следующего комментария.
  const timer = setInterval(() => {
    drain().then(() => writeJson(dataPath("heartbeat.json"), { ...(readJson(dataPath("heartbeat.json"), {}) || {}), igQueue: new Date().toISOString() })).catch((e) => console.error("[ig] фоновый разбор очереди:", e?.message || e));
  }, num("IG_QUEUE_POLL_MS", 60_000));
  timer.unref();
  const port = num("PORT", 3100);
  server.listen(port, env("HOST", "127.0.0.1"), () => console.log(`ecopolis-zavod слушает ${env("HOST", "127.0.0.1")}:${port}`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startServer();
