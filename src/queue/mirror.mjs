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
import { latestById, readJson, readJsonl, writeAtomic, writeJson } from "../lib/files.mjs";
import { request } from "../lib/http.mjs";
import { alert, resolve } from "../lib/notify.mjs";
import { dueAt, mskDate, mskTime } from "../lib/time.mjs";
import { STATUS_TITLE, preview } from "./format.mjs";
import { clearStop, setStop } from "./switch.mjs";

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

/** Расписание человеческим текстом: две недели вперёд и вышедшее за шестьдесят дней. Чистая функция. */
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
  // Пакеты, ушедшие человеку: публикацией они станут после отметки «Выложено».
  const handed = entries.filter((e) => e.status === "handed" && e.date < today);
  if (handed.length) {
    L.push("", "## Переданы на ручную выкладку, отметки «Выложено» нет", "");
    for (const e of handed.sort((a, b) => dueAt(a) - dueAt(b))) L.push(`- ${e.date} ${e.time} · ${titles[e.channel] || e.channel} · ${preview(e, 70)}`);
  }
  /* Вышедшее за шестьдесят дней. Сюда сессии смотрят перед тем, как писать: одинаковое
     начало площадка и читатель видят сразу, а проверка речи сравнивает как раз с этим
     окном. Раньше раздела не было, и «посмотри прошлые начала» отправляло в пустоту. */
  const past = entries.filter((e) => e.status === "published" && e.kind !== "reply" && e.date < today && e.date >= mskDate(now - 60 * 86_400_000)).sort((a, b) => dueAt(b) - dueAt(a));
  if (past.length) {
    L.push("", "## Вышло за 60 дней", "", "| Дата | Площадка | Материал | Начало текста |", "|---|---|---|---|");
    for (const e of past) L.push(`| ${e.date.slice(8, 10)}.${e.date.slice(5, 7)} ${e.time} | ${titles[e.channel] || e.channel} | ${String(e.material || "").replace(/\|/g, "/")} | ${preview(e, 70).replace(/\|/g, "/")} |`);
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
  // данных среди них нет: сервер отдаёт счёт. Текст вопросов из бота приходит, только
  // если клиент это разрешил (zavod.config.json, privacy); иначе список пуст, а число есть.
  for (const part of ["metrics", "metricSeries", "followers", "news", "newsHealth", "trends", "funnel", "questions", "questionCount", "comments", "commentCount", "tokens", "alerts"]) {
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

/**
 * Записи, которые при перехвате нельзя выпускать без взгляда человека. Чистая функция.
 *
 * Слот наступил до перехвата, а в копии запись ещё «одобрена». Копия старше остановки
 * сервера: между ними он мог успеть выпустить запись, и копия об этом не знает. Выпустить
 * такую запись с компьютера значит рискнуть вторым постом, а снять вышедший пост площадка
 * не даёт. YouTube сюда не входит: ролик там открывает сам YouTube, выпуск его только сверяет.
 */
export function atRisk(entries, now = Date.now()) {
  return entries.filter((e) => e.status === "approved" && e.channel !== "youtube" && dueAt(e) <= now);
}

/** Аварийный перехват: расписание ведёт этот компьютер. */
export async function takeover() {
  if (!flag("yes")) return { code: 1, lines: ["перехват делается осознанно: добавьте --yes. До этого убедитесь, что сервер действительно лежит, а не отвалилась сеть на этом компьютере"] };
  const queueFile = mirrorPath("queue.json");
  if (!existsSync(queueFile)) return { code: 2, lines: ["копии расписания нет (mirror/queue.json): перехватывать нечего. Копию снимает npm run mirror, пока сервер жив"] };
  const lines = [];
  // takeover: такую остановку сервер не даст снять командой из группы, только возвратом.
  const paused = await server("pause", { reason: "перехват расписания компьютером оператора", takeover: true }, 15_000);
  lines.push(paused.code === 0 ? "сервер ответил и остановлен (STOP)" : "сервер не ответил: рубильник не поставлен. После возврата он сам встанет на удержание и будет ждать кнопки");
  // Местный каталог данных собирается из копии. Старое местное состояние убирается в сторону.
  const local = dataPath("queue.jsonl");
  if (existsSync(local)) writeFileSync(`${local}.before-takeover`, readFileSync(local));
  const now = Date.now();
  const copy = JSON.parse(readFileSync(queueFile, "utf8"));
  const risky = atRisk(copy, now);
  const riskyIds = new Set(risky.map((e) => e.id));
  const note = "слот наступил до перехвата: сервер мог выпустить запись перед остановкой. Проверьте площадку глазами";
  const entries = copy.map((e) => (riskyIds.has(e.id) ? { ...e, status: "failed", note, at: new Date(now).toISOString(), by: "перехват" } : e));
  writeAtomic(local, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const ledger = existsSync(mirrorPath("ledger.json")) ? JSON.parse(readFileSync(mirrorPath("ledger.json"), "utf8")) : [];
  writeAtomic(dataPath("ledger.jsonl"), ledger.map((r) => JSON.stringify(r)).join("\n") + (ledger.length ? "\n" : ""));
  clearStop();
  writeJson(dataPath("heartbeat.json"), { runner: new Date(now).toISOString(), pid: process.pid });
  const state = readJson(mirrorPath("state.json"), {}) || {};
  writeJson(dataPath("TAKEOVER.json"), { since: new Date(now).toISOString(), serverPaused: paused.code === 0, copyFrom: state.pulledAt || null, held: risky.map((e) => `${e.channel}:${e.name}`) });
  const approved = entries.filter((e) => e.status === "approved").length;
  lines.push(`расписание перенесено: записей ${entries.length}, одобренных к выпуску ${approved}`);

  /* Слепое окно: что случилось на сервере после последней копии, компьютеру не известно. */
  if (state.pulledAt) {
    const gap = state.failSince ? Math.round((Date.parse(state.failSince) - Date.parse(state.pulledAt)) / 60_000) : null;
    lines.push(`копия снята ${mskDate(Date.parse(state.pulledAt))} в ${mskTime(Date.parse(state.pulledAt))} по Москве${gap !== null ? `, первый отказ сервера замечен через ${gap} мин.` : "."}`);
    lines.push("всё, что утверждающий одобрил, снял или отправил на правку после копии, компьютеру не известно. Спросите его в рабочей группе, не снимал ли он записи перед аварией: снятое уберите командой npm run queue -- cancel <имя> --channel=<площадка> --local");
  }
  if (risky.length) {
    lines.push("", `записей, чей слот наступил до перехвата: ${risky.length}. Компьютер их сам не выпустит: сервер мог выпустить их перед остановкой.`);
    for (const e of risky) lines.push(`  ${e.channel} · ${e.name} · слот ${e.date} ${e.time} · ${preview(e, 50)}`);
    lines.push("по каждой откройте площадку и посмотрите, вышла ли запись:");
    lines.push("  вышла:    npm run queue -- mark <имя> --channel=<площадка> --link=<ссылка> --local");
    lines.push("  не вышла: npm run queue -- move <имя> --channel=<площадка> --next --local");
  }
  lines.push("", "дальше: включите задачу «zavod-takeover» в планировщике (ops/windows/takeover.cmd, раз в 5 минут) либо запускайте npm run release руками");
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
    const res = await server("mark", { ref: r.id, link: r.link || "", externalId: r.externalId || "", at: r.at, note: "вышла при перехвате расписания", takeover: true });
    const stray = res.code === 0 && (res.lines || []).some((l) => /без согласия/.test(l));
    lines.push(`${res.code === 0 ? "✓" : "✗"} ${r.channel} · ${r.name}${stray ? " — ВЫШЛА БЕЗ СОГЛАСИЯ: на сервере запись была снята или ждала «да». В рабочую группу ушло сообщение" : ""}${res.code === 0 ? "" : `: ${(res.lines || []).join("; ")}`}`);
    if (res.code !== 0) failed++;
  }
  /* Пакеты на ручную выкладку, ушедшие в группу с компьютера. Серверу их нужно отметить
     переданными, иначе после возврата он отправит тот же пакет второй раз. */
  const handed = [...latestById(dataPath("queue.jsonl")).values()].filter((e) => e.status === "handed" && Date.parse(e.handedAt || 0) >= Date.parse(state.since) && !done.has(e.id));
  for (const e of handed) {
    const res = await server("mark", { ref: e.id, handed: true, packageMessageId: e.result?.packageMessageId || null, at: e.handedAt, note: "пакет отправлен при перехвате расписания" });
    lines.push(`${res.code === 0 ? "✓" : "✗"} ${e.channel} · ${e.name} (пакет на ручную выкладку)${res.code === 0 ? "" : `: ${(res.lines || []).join("; ")}`}`);
    if (res.code !== 0) failed++;
  }
  if (failed) {
    lines.push(`не передано записей: ${failed}. Выпуск на сервере НЕ включён: иначе они выйдут второй раз. Повторите команду`);
    return { code: 2, lines };
  }
  // handback: остановку ради перехвата сервер снимает только этой командой.
  const resumed = await server("resume", { handback: true });
  if (resumed.code !== 0) { lines.push(`вышедшее передано (${done.size}), но выпуск на сервере не включился: ${(resumed.lines || []).join("; ")}`); return { code: 2, lines }; }
  rmSync(dataPath("TAKEOVER.json"));
  // Местный выпуск больше работать не должен: рубильник ставится здесь же.
  setStop({ by: "возврат расписания", reason: "расписание возвращено серверу" });
  lines.push(`серверу передано вышедших записей: ${done.size}${handed.length ? `, пакетов на ручную выкладку: ${handed.length}` : ""}. Выпуск на сервере включён, местный остановлен`);
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
      // Когда сервер перестал отдавать копию: по этой отметке перехват называет слепое окно.
      if (!copy.ok) { const st = readJson(mirrorPath("state.json"), null); if (st && !st.failSince) writeJson(mirrorPath("state.json"), { ...st, failSince: new Date().toISOString() }); }
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
