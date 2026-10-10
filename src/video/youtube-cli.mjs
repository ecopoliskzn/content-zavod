#!/usr/bin/env node
// YouTube с компьютера оператора: разовый вход владельца канала и загрузка роликов.
//
//   npm run yt -- --login                       один раз: согласие в браузере, ключ ляжет в .env.local
//   npm run yt -- --upload --id=<номер|имя записи> --file=D:/video/priemka.mp4
//   npm run yt -- --status --video=<номер ролика>
//
// ЗАГРУЗКА ПРИВЯЗАНА К ЗАПИСИ ОЧЕРЕДИ. Название, описание и слот берутся из записи,
// которую уже одобрил человек клиента: ролик уходит закрытым с датой выхода из слота, и
// YouTube открывает его сам. Номер ролика записывается обратно в запись, и сервер в слот
// сверяет, что ролик открылся. Загрузить «просто файл» в обход очереди скрипт не даёт:
// то, что не согласовано, не выходит.
//
// ВХОД. Владелец канала входит СВОИМ аккаунтом Google на этом компьютере: открывается
// окно согласия, после «Разрешить» ключ обновления сам ложится в .env.local. Значение
// ключа скрипт не печатает никогда.

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { env } from "../lib/env.mjs";
import { setEnv } from "../lib/envfile.mjs";
import { request } from "../lib/http.mjs";
import { dueAt } from "../lib/time.mjs";
import { probe, status, upload } from "../channels/youtube.mjs";

const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);

/** Запрос к очереди: на сервер, если задан QUEUE_API_BASE, иначе к местному каталогу. */
async function queue(cmd, args) {
  const base = env("QUEUE_API_BASE");
  if (base) {
    const r = await request(`${base.replace(/\/+$/, "")}/admin/queue`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env("ADMIN_API_TOKEN")}` }, body: JSON.stringify({ cmd, args, actor: "S2" }), timeoutMs: 60_000 });
    return r.data || { code: 2, lines: [r.error] };
  }
  const { execute } = await import("../queue/commands.mjs");
  return execute(cmd, args, "S2");
}

async function login() {
  const id = env("YOUTUBE_CLIENT_ID");
  const secret = env("YOUTUBE_CLIENT_SECRET");
  if (!id || !secret) { console.error("нет YOUTUBE_CLIENT_ID или YOUTUBE_CLIENT_SECRET в .env.local: их выдаёт Google Cloud, раздел «Учётные данные»"); return 2; }
  const port = 53682;
  const redirect = `http://127.0.0.1:${port}/`;
  // Права берём сразу все нужные: задним числом к выданному ключу они не добавляются.
  const scope = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/yt-analytics.readonly"].join(" ");
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: "code", scope, access_type: "offline", prompt: "consent" })}`;
  console.log("Откройте адрес в браузере, где выполнен вход аккаунтом ВЛАДЕЛЬЦА КАНАЛА, и нажмите «Разрешить»:\n");
  console.log(url + "\n");
  const code = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, redirect);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<p>Готово. Это окно можно закрыть и вернуться в терминал.</p>");
      server.close();
      resolve(u.searchParams.get("code") || "");
    }).listen(port, "127.0.0.1");
    setTimeout(() => { server.close(); resolve(""); }, 5 * 60_000).unref();
  });
  if (!code) { console.error("согласие не получено за пять минут"); return 1; }
  const r = await request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }) });
  if (r.kind !== "ok" || !r.data?.refresh_token) { console.error(`ключ не получен: ${r.error || "Google не вернул ключ обновления"}`); return 1; }
  const file = setEnv({ YOUTUBE_REFRESH_TOKEN: r.data.refresh_token, YOUTUBE_TOKEN_ISSUED: new Date().toISOString().slice(0, 10) });
  console.log(`✓ ключ обновления сохранён в ${file} (YOUTUBE_REFRESH_TOKEN)`);
  const p = await probe();
  console.log(p.kind === "ok" ? `✓ ${p.detail}` : `⚠ проверка канала: ${p.error}`);
  console.log("Скопируйте эти три переменные на сервер тем же способом, каким туда кладутся остальные ключи.");
  return 0;
}

async function doUpload() {
  const ref = opt("id");
  const file = opt("file");
  if (!ref || !file) { console.error("нужны --id=<номер или имя записи очереди> и --file=<путь к ролику>"); return 1; }
  if (!existsSync(file)) { console.error(`нет файла: ${file}`); return 2; }
  const shown = await queue("show", { ref, channel: "youtube" });
  const entry = shown.data;
  if (!entry) { console.error((shown.lines || []).join("\n")); return shown.code || 1; }
  if (!["approved", "review"].includes(entry.status)) { console.error(`запись в статусе «${entry.status}»: загружается одобренное (или ждущее «да», тогда ролик останется закрытым до согласования)`); return 1; }
  if (entry.extra?.youtubeId) { console.error(`ролик уже загружен: https://www.youtube.com/watch?v=${entry.extra.youtubeId}`); return 1; }
  const due = dueAt(entry);
  // Дата выхода ставится только одобренной записи: неодобренный ролик сам не откроется.
  const publishAt = entry.status === "approved" && due > Date.now() + 10 * 60_000 ? new Date(due).toISOString() : undefined;
  console.log(`загружаю «${entry.title}»${publishAt ? `, выход ${entry.date} в ${entry.time} МСК` : ", без даты выхода (закрытым)"}…`);
  const res = await upload({ file, title: entry.title, description: entry.text || "", tags: entry.tags || [], publishAt, privacy: "private" });
  if (!res.ok) { console.error(`✗ ${res.error}`); return 1; }
  console.log(`✓ загружено: https://www.youtube.com/watch?v=${res.id} · доступ: ${res.privacy}`);
  if (res.warning) console.error(`⚠ ${res.warning}`);
  const saved = await queue("extra", { ref: entry.id, fields: { youtubeId: res.id, youtubePublishAt: publishAt || "" } });
  console.log((saved.lines || []).join("\n"));
  return saved.code || 0;
}

let code = 1;
if (flag("login")) code = await login();
else if (flag("upload")) code = await doUpload();
else if (flag("status")) {
  const s = await status(opt("video"));
  console.log(s.kind === "ok" ? `«${s.title}» · доступ ${s.privacy}${s.publishAt ? ` · выход ${s.publishAt}` : ""} · обработка ${s.upload}` : `✗ ${s.error}`);
  code = s.kind === "ok" ? 0 : s.kind === "network" ? 2 : 1;
} else console.error("что сделать: --login | --upload --id= --file= | --status --video=");
process.exitCode = code;
