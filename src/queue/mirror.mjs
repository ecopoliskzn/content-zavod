#!/usr/bin/env node
// Дубль расписания на компьютере оператора. Хозяин очереди — сервер; здесь его копия,
// сторож и аварийный перехват.
//
//   npm run mirror                      снять копию очереди и журнала, обновить РАСПИСАНИЕ.md
//   npm run mirror -- --watch           сторож: сервер молчит — тревога в рабочую группу
//   npm run mirror -- --takeover --yes  АВАРИЯ: расписание ведёт этот компьютер
//   npm run mirror -- --handback        сервер ожил: вернуть ему вышедшее и включить выпуск
//
// ЧТО ДАЁТ ДУБЛЬ.
//  1. Копия. Сервер сгорел — расписание, тексты и журнал выпусков на руках, свежестью
//     не старше четверти часа. Персональных данных в копии нет: заявки и подписчики с
//     сервера не уезжают никогда.
//  2. Сторож. Сервер не отвечает или выпуск на нём не ходит — в рабочую группу уходит
//     тревога. Сервер о собственной смерти сообщить не может, это видно только снаружи.
//  3. Перехват. Сервер лежит дольше, чем терпит расписание, — выпуск одобренного ведёт
//     компьютер. Только вручную и одной командой: автоматический перехват при первом же
//     сетевом сбое даёт двух выпускающих и задвоенные посты.
//
// ПРАВИЛО ПЕРЕХВАТА: ВЫПУСКАЕТ ВСЕГДА КТО-ТО ОДИН. Перехват ставит серверу рубильник STOP
// (если сервер отвечает). Если не отвечает, страхует сам сервер: после простоя дольше
// получаса он встаёт на удержание и ждёт кнопки человека. Возврат (--handback) сначала
// сообщает серверу, что вышло без него, и только потом включает выпуск.
//
// Согласовать новое во время перехвата нельзя: кнопки согласования обрабатывает сервер.
// Компьютер выпускает только то, что было одобрено до аварии.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../lib/config.mjs";
import { PROJECT_ROOT, dataPath, env } from "../lib/env.mjs";
import { readJson, readJsonl, writeAtomic, writeJson } from "../lib/files.mjs";
import { request } from "../lib/http.mjs";
import { alert, resolve } from "../lib/notify.mjs";
import { dueAt, mskDate, mskTime } from "../lib/time.mjs";
import { STATUS_TITLE, preview } from "./format.mjs";

const flag = (name) => process.argv.includes(`--${name}`);
const mirrorDir = () => path.resolve(env("MIRROR_DIR", path.join(PROJECT_ROOT, "mirror")));
const mirrorPath = (...parts) => path.join(mirrorDir(), ...parts);
const base = () => env("QUEUE_API_BASE").replace(/\/+$/, "");

async function server(cmd, args = {}, timeoutMs = 30_000) {
  if (!base()) return { code: 2, lines: ["нет QUEUE_API_BASE: адрес сервера не задан"] };
  const res = await request(`${base()}/admin/queue`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env("ADMIN_API_TOKEN")}` },
    body: JSON.stringify({ cmd, args, actor: `${env("OPERATOR_NAME", "оператор")} (дубль)` }),
    timeoutMs,
  });
  if (res.kind !== "ok" && !res.data?.lines) return { code: 2, lines: [`сервер не ответил: ${res.error}`], network: true };
  return res.data;
}

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** Расписание на две недели человеческим текстом. Чистая функция. */
export function renderSchedule(entries, now = Date.now(), titles = {}, meta = {}) {
  const today = mskDate(now);
  const horizon = mskDate(now + 14 * 86_400_000);
  const live = entries.filter((e) => e.status !== "cancelled" && e.date >= today && e.date <= horizon).sort((a, b) => dueAt(a) - dueAt(b));
  const L = ["# Расписание выпуска", "", `Копия с сервера на ${mskDate(now)} ${mskTime(now)} по Москве.${meta.stopped ? " **Выпуск на сервере остановлен (STOP).**" : ""}${meta.held ? " **Выпуск на сервере ждёт кнопки после простоя (HOLD).**" : ""}`, ""];
  if (!live.length) L.push("На ближайшие две недели в очереди пусто.");
  let day = "";
  for (const e of live) {
    if (e.date !== day) {
      day = e.date;
      const wd = WEEKDAYS[new Date(Date.parse(`${day}T12:00:00+03:00`)).getUTCDay()];
      L.push("", `## ${day.slice(8, 10)}.${day.slice(5, 7)}, ${wd}`, "", "| Время | Площадка | Статус | Материал | Начало текста |", "|---|---|---|---|---|");
    }
    L.push(`| ${e.time} | ${titles[e.channel] || e.channel} | ${STATUS_TITLE[e.status] || e.status} | ${String(e.material || "").replace(/\|/g, "/")} | ${preview(e, 70).replace(/\|/g, "/")} |`);
  }
  const waiting = entries.filter((e) => ["draft", "rework", "review"].includes(e.status));
  if (waiting.length) {
    L.push("", "## Не одобрено", "");
    for (const e of waiting.sort((a, b) => dueAt(a) - dueAt(b))) L.push(`- ${e.date} ${e.time} · ${titles[e.channel] || e.channel} · ${STATUS_TITLE[e.status]} · ${preview(e, 70)}${e.note ? ` · заметка: ${String(e.note).slice(0, 80)}` : ""}`);
  }
  const failed = entries.filter((e) => ["failed", "expired"].includes(e.status));
  if (failed.length) {
    L.push("", "## Требуют решения", "");
    for (const e of failed) L.push(`- ${e.date} ${e.time} · ${titles[e.channel] || e.channel} · ${STATUS_TITLE[e.status]} · ${preview(e, 70)}${e.note ? ` · ${String(e.note).slice(0, 100)}` : ""}`);
  }
  return L.join("\n") + "\n";
}

/** Снять копию. */
export async function pull() {
  const out = await server("export", {}, 60_000);
  if (out.code !== 0 || !out.data) return { ok: false, error: (out.lines || []).join("; ") || "сервер не отдал копию" };
  const d = out.data;
  mkdirSync(mirrorDir(), { recursive: true });
  writeAtomic(mirrorPath("queue.json"), JSON.stringify(d.queue, null, 1));
  writeAtomic(mirrorPath("ledger.json"), JSON.stringify(d.ledger, null, 1));
  // Остальные части снимка: сырьё для сессий Codex и для витрины Obsidian. Персональных
  // данных среди них нет: сервер отдаёт только счёт и обезличенные вопросы.
  for (const part of ["metrics", "metricSeries", "followers", "news", "newsHealth", "trends", "funnel", "questions", "tokens", "alerts"]) {
    if (d[part] !== undefined) writeAtomic(mirrorPath(`${part}.json`), JSON.stringify(d[part], null, 1));
  }
  for (const r of d.reports || []) {
    mkdirSync(mirrorPath("reports", "weekly"), { recursive: true });
    writeAtomic(mirrorPath("reports", "weekly", `${r.week}.md`), r.md);
    if (r.json) writeAtomic(mirrorPath("reports", "weekly", `${r.week}.json`), JSON.stringify(r.json, null, 1));
  }
  const titles = Object.fromEntries(Object.entries(config().channels).map(([k, v]) => [k, v.title]));
  writeAtomic(mirrorPath("РАСПИСАНИЕ.md"), renderSchedule(d.queue, Date.now(), titles, { stopped: d.stopped, held: d.held }));
  writeJson(mirrorPath("state.json"), { pulledAt: new Date().toISOString(), serverAt: d.at, runnerAt: d.heartbeat?.runner || null, stopped: Boolean(d.stopped), held: Boolean(d.held), entries: d.queue.length });
  return { ok: true, entries: d.queue.length, runnerAt: d.heartbeat?.runner || null, stopped: d.stopped, held: d.held };
}

/** Сторож: одна проверка. Чистая оценка вынесена в judge() ради теста. */
export function judge({ health, copyAgeMin, now = Date.now(), takeover = false }) {
  if (takeover) return { key: "", text: "" }; // расписание ведёт компьютер: молчание сервера известно
  if (!health) return { key: "server:down", text: "Сервер завода не отвечает. Выпуск по расписанию и бот сейчас не работают." };
  const silentMin = health.runnerAt ? (now - Date.parse(health.runnerAt)) / 60_000 : Infinity;
  if (silentMin > 20) return { key: "server:runner", text: `Сервер отвечает, но выпуск на нём не ходит уже ${Number.isFinite(silentMin) ? Math.round(silentMin) : "много"} мин. Одобренное не выйдет.` };
  if (copyAgeMin > 90) return { key: "mirror:stale", text: `Копия расписания на компьютере оператора не обновлялась ${Math.round(copyAgeMin)} мин.` };
  return { key: "", text: "" };
}

export async function watch() {
  const res = base() ? await request(`${base()}/health`, { timeoutMs: 15_000, retries: 1, retryDelayMs: 20_000 }) : { kind: "refused" };
  const state = readJson(mirrorPath("state.json"), {}) || {};
  const copyAgeMin = state.pulledAt ? (Date.now() - Date.parse(state.pulledAt)) / 60_000 : 0;
  const verdict = judge({ health: res.kind === "ok" ? res.data : null, copyAgeMin, takeover: existsSync(dataPath("TAKEOVER.json")) });
  for (const key of ["server:down", "server:runner", "mirror:stale"]) if (key !== verdict.key) resolve(key);
  if (!verdict.key) return { ok: true };
  await alert(verdict.key, verdict.text, { action: "перешлите это сообщение оператору. Если сервер не поднимется за час, оператор переведёт расписание на свой компьютер" });
  return { ok: false, ...verdict };
}

/** Аварийный перехват: расписание ведёт этот компьютер. */
export async function takeover() {
  if (!flag("yes")) return { code: 1, lines: ["перехват делается осознанно: добавьте --yes. До этого убедитесь, что сервер действительно лежит, а не отвалилась сеть на этом компьютере"] };
  const queueFile = mirrorPath("queue.json");
  if (!existsSync(queueFile)) return { code: 2, lines: ["копии расписания нет (mirror/queue.json): перехватывать нечего. Копию снимает npm run mirror, пока сервер жив"] };
  const lines = [];
  const paused = await server("pause", { reason: "перехват расписания компьютером оператора" }, 15_000);
  lines.push(paused.code === 0 ? "сервер ответил и остановлен (STOP)" : "сервер не ответил: рубильник не поставлен. После возврата он сам встанет на удержание и будет ждать кнопки");
  // Местный каталог данных собирается из копии. Старое местное состояние убирается в сторону.
  const local = dataPath("queue.jsonl");
  if (existsSync(local)) writeFileSync(`${local}.before-takeover`, readFileSync(local));
  const entries = JSON.parse(readFileSync(queueFile, "utf8"));
  writeAtomic(local, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const ledger = existsSync(mirrorPath("ledger.json")) ? JSON.parse(readFileSync(mirrorPath("ledger.json"), "utf8")) : [];
  writeAtomic(dataPath("ledger.jsonl"), ledger.map((r) => JSON.stringify(r)).join("\n") + (ledger.length ? "\n" : ""));
  for (const f of ["STOP", "HOLD"]) if (existsSync(dataPath(f))) rmSync(dataPath(f));
  writeJson(dataPath("heartbeat.json"), { runner: new Date().toISOString(), pid: process.pid });
  writeJson(dataPath("TAKEOVER.json"), { since: new Date().toISOString(), serverPaused: paused.code === 0, copyFrom: readJson(mirrorPath("state.json"), {})?.pulledAt || null });
  const approved = entries.filter((e) => e.status === "approved").length;
  lines.push(`расписание перенесено: записей ${entries.length}, одобренных к выпуску ${approved}`);
  lines.push("дальше: включите задачу «zavod-takeover» в планировщике (ops/windows/takeover.cmd, раз в 5 минут) либо запускайте npm run release руками");
  lines.push("когда сервер оживёт: npm run mirror -- --handback. До этого выпуск на сервере не включать");
  return { code: 0, lines };
}

/** Возврат: сервер узнаёт, что вышло без него, и снова ведёт расписание. */
export async function handback() {
  const state = readJson(dataPath("TAKEOVER.json"));
  if (!state) return { code: 1, lines: ["перехвата не было: файла TAKEOVER.json нет"] };
  const lines = [];
  const done = new Map();
  for (const r of readJsonl(dataPath("ledger.jsonl"))) if (r.status === "published" && Date.parse(r.at) >= Date.parse(state.since)) done.set(r.id, r);
  let failed = 0;
  for (const r of done.values()) {
    const res = await server("mark", { ref: r.id, link: r.link || "", externalId: r.externalId || "", at: r.at, note: "вышла при перехвате расписания" });
    lines.push(`${res.code === 0 ? "✓" : "✗"} ${r.channel} · ${r.name}${res.code === 0 ? "" : `: ${(res.lines || []).join("; ")}`}`);
    if (res.code !== 0) failed++;
  }
  if (failed) {
    lines.push(`не передано записей: ${failed}. Выпуск на сервере НЕ включён: иначе они выйдут второй раз. Повторите команду`);
    return { code: 2, lines };
  }
  const resumed = await server("resume");
  if (resumed.code !== 0) { lines.push(`вышедшее передано (${done.size}), но выпуск на сервере не включился: ${(resumed.lines || []).join("; ")}`); return { code: 2, lines }; }
  rmSync(dataPath("TAKEOVER.json"));
  // Местный выпуск больше работать не должен: рубильник ставится здесь же.
  writeFileSync(dataPath("STOP"), `расписание возвращено серверу ${new Date().toISOString()}`, "utf8");
  lines.push(`серверу передано вышедших записей: ${done.size}. Выпуск на сервере включён, местный остановлен`);
  lines.push("выключите задачу «zavod-takeover» в планировщике");
  return { code: 0, lines };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let code = 0;
  try {
    if (flag("takeover")) { const r = await takeover(); r.lines.forEach((l) => console.log(l)); code = r.code; }
    else if (flag("handback")) { const r = await handback(); r.lines.forEach((l) => console.log(l)); code = r.code; }
    else if (flag("watch")) {
      const copy = await pull();
      const r = await watch();
      if (!r.ok || !copy.ok) console.log(`${new Date().toISOString()} сторож: ${r.ok ? "сервер жив" : r.text}${copy.ok ? "" : `; копия не снята: ${copy.error}`}`);
      code = r.ok ? 0 : 1;
    } else {
      const r = await pull();
      if (r.ok) console.log(`${new Date().toISOString()} копия снята: записей ${r.entries}${r.stopped ? ", выпуск на сервере остановлен" : ""}${r.held ? ", выпуск ждёт кнопки после простоя" : ""}`);
      else { console.error(`копия не снята: ${r.error}`); code = 2; }
    }
  } catch (e) {
    console.error(`сбой дубля расписания: ${e?.stack || e}`);
    code = 2;
  }
  process.exitCode = code;
}
