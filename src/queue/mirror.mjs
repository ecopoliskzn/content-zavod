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
// ПРАВИЛО ПЕРЕХВАТА: ВЫПУСКАЕТ ВСЕГДА КТО-ТО ОДИН. Поэтому перехват начинается, только
// когда известно, что сервер не выпускает:
//   · сервер ответил и принял остановку (отметка перехвата в файле STOP) либо
//   · сервер не отвечает, и оператор сам его остановил и подтвердил это флагом
//     --server-stopped. Молчание сервера остановкой не считается: расписание на нём идёт
//     по cron и от того, отвечает ли он снаружи, не зависит.
// Сервер ответил отказом (устарел ключ оператора) — перехвата нет: сервер жив и выпускает.
// Выпуск остановил человек — перехвата тоже нет: расписание стоит по его решению.
//
// Пока перехват идёт, компьютер перед каждым проходом сверяется с сервером
// (src/queue/takeover.mjs): принимает остановку человека и снятые записи, а вернувшемуся
// серверу сразу ставит отметку перехвата. Возврат (--handback) сначала останавливает
// выпуск на компьютере, потом сообщает серверу, что вышло без него, и только потом
// включает выпуск на сервере.
//
// Согласовать новое во время перехвата нельзя: кнопки согласования обрабатывает сервер.
// Компьютер выпускает только то, что было одобрено до аварии.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../lib/config.mjs";
import { PROJECT_ROOT, dataPath, env } from "../lib/env.mjs";
import { latestById, lock, readJson, readJsonl, writeAtomic, writeJson } from "../lib/files.mjs";
import { request, sleep } from "../lib/http.mjs";
import { alert, resolve } from "../lib/notify.mjs";
import { dueAt, mskDate, mskTime } from "../lib/time.mjs";
import { STATUS_TITLE, freshness, preview } from "./format.mjs";
import { base, server } from "./remote.mjs";
import { clearHold, clearStop, isTakeover, setStop, stopState } from "./switch.mjs";
import { HELD_BY, SYNC_BY, TAKEOVER_REASON, adoptServerState, holdFields, sayAdopted } from "./takeover.mjs";

const flag = (name) => process.argv.includes(`--${name}`);
const mirrorDir = () => path.resolve(env("MIRROR_DIR", path.join(PROJECT_ROOT, "mirror")));
const mirrorPath = (...parts) => path.join(mirrorDir(), ...parts);

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

/** Снять копию. Допуск на часы нужен только тестам: в жизни архив старше копии на часы. */
export async function pull({ toleranceMs = 60_000 } = {}) {
  const out = await server("export", {}, 60_000);
  if (out.code !== 0 || !out.data) return { ok: false, error: (out.lines || []).join("; ") || "сервер не отдал копию" };
  const d = out.data;
  mkdirSync(mirrorDir(), { recursive: true });
  /* КОПИЮ НЕЛЬЗЯ ЗАТЕРЕТЬ БОЛЕЕ СТАРОЙ. Сервер, восстановленный из архива либо из снимка
     диска, отдаёт расписание суточной давности. Если принять его как обычную копию,
     пропадёт единственное место, где записано, что вышло и что сняли после архива.
     Поэтому снимок старше копии откладывается в сторону, а копия остаётся как была. */
  const old = existsSync(mirrorPath("queue.json")) ? { queue: readJson(mirrorPath("queue.json"), []) || [], ledger: readJson(mirrorPath("ledger.json"), []) || [] } : null;
  if (d.restored || (old && freshness(d.queue, d.ledger) < freshness(old.queue, old.ledger) - toleranceMs)) {
    mkdirSync(mirrorPath("rollback"), { recursive: true });
    writeAtomic(mirrorPath("rollback", "queue.json"), JSON.stringify(d.queue, null, 1));
    writeAtomic(mirrorPath("rollback", "ledger.json"), JSON.stringify(d.ledger, null, 1));
    const st = readJson(mirrorPath("state.json"), {}) || {};
    writeJson(mirrorPath("state.json"), { ...st, rolledBackAt: st.rolledBackAt || new Date().toISOString(), serverRestored: Boolean(d.restored) });
    return { ok: false, rolledBack: true, error: "сервер отдал расписание старше копии: похоже, он восстановлен из архива либо из снимка диска. Копия не тронута. Сверьте сервер с ней: npm run mirror -- --reconcile" };
  }
  writeAtomic(mirrorPath("queue.json"), JSON.stringify(d.queue, null, 1));
  writeAtomic(mirrorPath("ledger.json"), JSON.stringify(d.ledger, null, 1));
  // Остальные части снимка: сырьё для сессий Codex и для витрины Obsidian. Персональных
  // данных среди них нет: сервер отдаёт счёт. Текст вопросов из бота приходит, только
  // если клиент это разрешил (zavod.config.json, privacy); иначе список пуст, а число есть.
  for (const part of ["metrics", "metricSeries", "followers", "youtubeHistory", "news", "newsHealth", "trends", "funnel", "questions", "questionCount", "comments", "commentCount", "commentsHealth", "tokens", "alerts"]) {
    if (d[part] !== undefined) writeAtomic(mirrorPath(`${part}.json`), JSON.stringify(d[part], null, 1));
  }
  for (const r of d.reports || []) {
    mkdirSync(mirrorPath("reports", "weekly"), { recursive: true });
    writeAtomic(mirrorPath("reports", "weekly", `${r.week}.md`), r.md);
    if (r.json) writeAtomic(mirrorPath("reports", "weekly", `${r.week}.json`), JSON.stringify(r.json, null, 1));
  }
  const titles = Object.fromEntries(Object.entries(config().channels).map(([k, v]) => [k, v.title]));
  writeAtomic(mirrorPath("РАСПИСАНИЕ.md"), renderSchedule(d.queue, Date.now(), titles, { stopped: d.stopped, held: d.held }));
  // stoppedByHuman — выпуск остановил человек, а не перехват: по этой отметке перехват
  // отказывается начинаться, когда сервер уже не отвечает и спросить его нельзя.
  writeJson(mirrorPath("state.json"), { pulledAt: new Date().toISOString(), serverAt: d.at, runnerAt: d.heartbeat?.runner || null, stopped: Boolean(d.stopped), stoppedByHuman: Boolean(d.stop?.human), held: Boolean(d.held), entries: d.queue.length });
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

/** Сервер отдал расписание старше копии: остановить выпуск на нём до сверки и сказать людям. */
export async function rolledBack() {
  // Команда только останавливает. Если отметка из архива на сервере уже стоит, она ничего не меняет.
  await server("rollback", { reason: "расписание на сервере старше копии на компьютере оператора" }, 15_000);
  await alert("server:rolledback", "Сервер отдал расписание старше, чем копия на компьютере оператора: похоже, он восстановлен из архива либо из снимка диска. Что вышло и что сняли после архива, он не знает. Выпуск на нём остановлен до сверки с копией.", { action: "перешлите это сообщение оператору. Его команда: npm run mirror -- --reconcile. Кнопку «Продолжить выпуск» до этого не нажимать" });
}

/**
 * Записи, которые при перехвате нельзя выпускать без взгляда человека. Чистая функция.
 *
 * Слот наступил до перехвата, а в копии запись ещё «одобрена» либо «выходит». Сервер мог
 * успеть выпустить её перед остановкой, и копия об этом не знает. Выпустить такую запись с
 * компьютера значит рискнуть вторым постом, а снять вышедший пост площадка не даёт.
 * YouTube сюда не входит: ролик там открывает сам YouTube, выпуск его только сверяет.
 */
export function atRisk(entries, now = Date.now()) {
  return entries.filter((e) => e.channel !== "youtube" && ((e.status === "approved" && dueAt(e) <= now) || e.status === "running"));
}

const SERVER_STOP_HOWTO = [
  "сервер не ответил этому компьютеру. Это ещё не значит, что выпуск на нём стоит: расписание на сервере идёт по cron и от того, отвечает ли он снаружи, не зависит.",
  "перехват при работающем выпуске даёт двух выпускающих и задвоенные посты, а снять вышедший пост площадка не даёт.",
  "сначала проверьте связь на этом компьютере: если не открывается ни один сайт, лежит не сервер.",
  "потом остановите выпуск на сервере одним из двух способов:",
  "  · по SSH, если сервер пускает:  ssh zavod@<адрес сервера> \"cd /opt/ecopolis-zavod/current && node src/queue/cli.mjs pause --takeover\"",
  "  · в панели Timeweb: сервер → «Выключить»",
  "и повторите с подтверждением: npm run mirror -- --takeover --yes --server-stopped",
];

const stamp = (iso) => `${mskDate(Date.parse(iso))} в ${mskTime(Date.parse(iso))} по Москве`;

/** Аварийный перехват: расписание ведёт этот компьютер. Время передаётся только в тестах. */
export async function takeover({ now = Date.now() } = {}) {
  if (!flag("yes")) return { code: 1, lines: ["перехват делается осознанно: добавьте --yes. До этого убедитесь, что сервер действительно лежит, а не отвалилась сеть на этом компьютере"] };
  if (isTakeover()) {
    const cur = readJson(dataPath("TAKEOVER.json"), {}) || {};
    return { code: 1, lines: [`перехват уже идёт${cur.since ? ` с ${stamp(cur.since)}` : ""}. Повторный перехват переписал бы местное расписание копией, и вышедшее с этого компьютера вышло бы второй раз. Вернуть расписание серверу: npm run mirror -- --handback`] };
  }
  if (!base()) return { code: 2, lines: ["нет QUEUE_API_BASE: это не компьютер оператора. Перехват делается только с него"] };
  if (!existsSync(mirrorPath("queue.json"))) return { code: 2, lines: ["копии расписания нет (mirror/queue.json): перехватывать нечего. Копию снимает npm run mirror, пока сервер жив"] };
  const lines = [];
  const before = readJson(mirrorPath("state.json"), {}) || {};

  /* Кто-то один. Перехват начинается, только когда известно, что сервер не выпускает. */
  const paused = await server("pause", { reason: TAKEOVER_REASON, takeover: true }, 15_000);
  if (paused.code !== 0 && !paused.network) {
    // Сервер ответил. Отказ по правилу: выпуск остановил человек. Иначе не подошёл ключ.
    if (paused.code === 1) return { code: 1, lines: paused.lines || [] };
    return { code: 2, lines: [...(paused.lines || []), "сервер жив и остановку не принял. Перехват сейчас дал бы двух выпускающих: сначала верните доступ к серверу, потом повторите"] };
  }
  const serverPaused = paused.code === 0;
  if (!serverPaused) {
    /* По копии выпуск остановил человек. Сервер лежит, и команду /start_release принять
       некому: если утверждающий разрешил запуск словами в группе, оператор подтверждает
       это флагом. Без подтверждения перехвата нет. */
    if (before.stoppedByHuman && !flag("start-confirmed")) return { code: 1, lines: [`сервер не ответил, а по последней копии (${before.pulledAt ? stamp(before.pulledAt) : "время неизвестно"}) выпуск остановлен человеком. Перехватывать нечего: расписание стоит по его решению. Включает его команда /start_release в рабочей группе, когда сервер вернётся`, "утверждающий уже разрешил запуск словами в рабочей группе, а сервер лежит: повторите с флагом --start-confirmed"] };
    if (before.stoppedByHuman) lines.push("по последней копии выпуск был остановлен человеком. Запуск подтверждён оператором со слов утверждающего (--start-confirmed)");
    if (!flag("server-stopped")) return { code: 1, lines: SERVER_STOP_HOWTO };
    lines.push("сервер не ответил. Выпуск на нём остановлен со слов оператора (--server-stopped)");
  } else {
    lines.push("сервер ответил и остановлен: отметка перехвата стоит в его файле STOP");
    // Свежая копия после остановки: в ней всё, что утверждающий решил до этой минуты.
    const fresh = await pull().catch((e) => ({ ok: false, error: e?.message || String(e) }));
    lines.push(fresh.ok ? "копия расписания снята заново, уже после остановки сервера" : `свежую копию снять не удалось (${fresh.error}): перехват идёт по прежней`);
  }

  // Местный каталог данных собирается из копии. Старое местное состояние убирается в сторону.
  const local = dataPath("queue.jsonl");
  if (existsSync(local)) writeFileSync(`${local}.before-takeover`, readFileSync(local));
  const state = readJson(mirrorPath("state.json"), {}) || {};
  const copy = JSON.parse(readFileSync(mirrorPath("queue.json"), "utf8"));
  // Отметки времени пишутся по настоящим часам: по ним возврат отличает сделанное при перехвате.
  const since = new Date().toISOString();
  const risky = atRisk(copy, now);
  const riskyIds = new Set(risky.map((e) => e.id));
  const note = "слот наступил до перехвата: сервер мог выпустить запись перед остановкой. Проверьте площадку глазами";
  // heldFrom и heldAt: какой запись была в копии. По ним возврат расскажет серверу из архива, что она была начата.
  const entries = copy.map((e) => (riskyIds.has(e.id) ? { ...e, ...holdFields(note), heldFrom: e.status, heldAt: e.at, at: since, by: HELD_BY } : e));
  writeAtomic(local, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const ledger = existsSync(mirrorPath("ledger.json")) ? JSON.parse(readFileSync(mirrorPath("ledger.json"), "utf8")) : [];
  writeAtomic(dataPath("ledger.jsonl"), ledger.map((r) => JSON.stringify(r)).join("\n") + (ledger.length ? "\n" : ""));
  // Местные рубильники остались от прошлой жизни каталога (их ставит возврат): снимаются оба.
  clearStop({ all: true });
  clearHold();
  writeJson(dataPath("heartbeat.json"), { runner: since, pid: process.pid });
  // Файл перехвата пишется последним: до него выпуск на этом компьютере не начнётся.
  // copyFresh: насколько свежа копия. По нему видно, что вернувшийся сервер старше её.
  writeJson(dataPath("TAKEOVER.json"), { since, serverPaused, copyFrom: state.pulledAt || null, copyFresh: freshness(copy, ledger), held: risky.map((e) => `${e.channel}:${e.name}`) });
  lines.push(`расписание перенесено: записей ${entries.length}, одобренных к выпуску ${entries.filter((e) => e.status === "approved").length}`);

  let left = risky;
  if (serverPaused) {
    /* Сервер на связи: о записях со слотом до перехвата спрашиваем его, а не человека. */
    const seen = await adoptServerState().catch(() => ({ reached: false }));
    const said = sayAdopted(seen);
    if (said) lines.push(`сверка с сервером: ${said}`);
    if (seen.busy) lines.push("на сервере ещё идёт проход выпуска, начатый до остановки: записи со слотом до перехвата придержаны, пока он не закончится. Компьютер спросит сервер снова при ближайшем проходе");
    const still = new Set([...latestById(local).values()].filter((e) => e.status === "failed" && e.takeoverHold).map((e) => e.id));
    left = risky.filter((e) => still.has(e.id));
  } else if (state.pulledAt) {
    /* Слепое окно: что случилось на сервере после последней копии, компьютеру не известно. */
    const gap = state.failSince ? Math.round((Date.parse(state.failSince) - Date.parse(state.pulledAt)) / 60_000) : null;
    lines.push(`копия снята ${stamp(state.pulledAt)}${gap !== null ? `, первый отказ сервера замечен через ${gap} мин.` : "."}`);
    lines.push("всё, что утверждающий одобрил, снял или отправил на правку после копии, компьютеру не известно. Спросите его в рабочей группе, не снимал ли он записи перед аварией: снятое уберите командой npm run queue -- cancel <имя> --channel=<площадка> --local");
  }
  if (left.length) {
    lines.push("", `записей, чей слот наступил до перехвата: ${left.length}. Компьютер их сам не выпустит: сервер мог выпустить их перед остановкой.`);
    for (const e of left) lines.push(`  ${e.channel} · ${e.name} · слот ${e.date} ${e.time} · ${preview(e, 50)}`);
    lines.push("по каждой откройте площадку и посмотрите, вышла ли запись:");
    lines.push("  вышла:    npm run queue -- mark <имя> --channel=<площадка> --link=<ссылка> --local");
    lines.push("  не вышла: npm run queue -- move <имя> --channel=<площадка> --next --local");
  }
  lines.push("", "дальше: включите задачу «zavod-takeover» в планировщике (ops/windows/takeover.cmd, раз в 5 минут) либо запускайте npm run release руками");
  if (!serverPaused) lines.push("когда сервер включится, компьютер при ближайшем проходе сам поставит ему отметку перехвата. Если сервер простоял меньше получаса, до этой минуты выпускать могут обе машины: включайте его, когда компьютер работает и на связи");
  lines.push("когда сервер оживёт: npm run mirror -- --handback. До этого выпуск на сервере не включать");
  return { code: 0, lines };
}

/** Дождаться конца идущего прохода выпуска на этом компьютере и занять его замок. */
async function holdRunner(waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    const release = lock(dataPath("runner.lock"));
    if (release) return release;
    if (Date.now() >= until) return null;
    await sleep(Math.min(5_000, Math.max(50, waitMs / 10)));
  }
}

/** Что копия знает о записи: ровно то, что нужно серверу для сверки. Текста записи здесь нет. */
const known = (e) => ({
  id: e.id, status: e.status, at: e.at, contentHash: e.contentHash || "", done: e.done || [], attempts: e.attempts ?? 0, result: e.result || null,
  publishedAt: e.publishedAt || "", handedAt: e.handedAt || "", note: e.note || "",
  channel: e.channel, kind: e.kind, name: e.name, material: e.material || "", date: e.date, time: e.time,
});

/**
 * Возврат: сервер узнаёт, что вышло без него, и снова ведёт расписание.
 *
 * Порядок важен, и каждый шаг закрывает свою дыру:
 *   1. сервер должен отвечать: иначе возвращать некому, и местный выпуск не трогаем;
 *   2. местный выпуск останавливается ДО передачи и ждёт конца идущего прохода: иначе
 *      запись, вышедшая в эти секунды, серверу не передалась бы и вышла бы второй раз;
 *   3. серверу передаётся всё, что сделал компьютер: вышедшее, пакеты на ручную выкладку,
 *      начатое и не законченное, снятое оператором;
 *   4. сервер сверяется с тем, что копия знала до перехвата. Для живого сервера это пустой
 *      шаг. Сервер, поднятый из архива, знает меньше копии: без сверки он выпустил бы
 *      второй раз то, что вышло после архива, и выпустил бы снятое;
 *   5. только после этого на сервере снимается отметка перехвата. Остановку человеком она
 *      не снимает.
 * Команда повторяема: сервер одну и ту же запись дважды в журнал не пишет.
 */
export async function handback({ waitMs = 120_000 } = {}) {
  const state = readJson(dataPath("TAKEOVER.json"));
  if (!state) return { code: 1, lines: ["перехвата не было: файла TAKEOVER.json нет. Если выпуск на сервере при этом стоит с отметкой перехвата (команда /plan в группе так и пишет), снимите её: npm run queue -- resume --handback"] };
  const lines = [];

  const pulse = await server("pulse", {}, 15_000);
  if (pulse.code !== 0 || !pulse.data?.statuses) {
    return { code: 2, lines: [...(pulse.lines || []), stopState().stopped ? "сервер не готов принять расписание: возврат не начат. Выпуск на этом компьютере при этом стоит: его остановил прошлый заход возврата либо человек. Продолжить перехват: npm run queue -- resume --local" : "сервер не готов принять расписание: возврат не начат, выпуск на этом компьютере продолжается"] };
  }
  const remote = pulse.data.statuses;
  /* Сервер старше копии: он поднят из архива либо откатан снимком диска. Такой сервер
     получает отметку «восстановлен»: пока она стоит, сделанное компьютером он принимает
     как факт и не поднимает тревогу «вышла без согласия» по записям из архива. */
  const older = Boolean(state.copyFresh && pulse.data.fresh && pulse.data.fresh < state.copyFresh - 60_000);
  if (older && !pulse.data.restored) await server("rollback", { reason: "расписание на сервере старше копии на компьютере оператора" }, 15_000);
  if (older || pulse.data.restored) lines.push("сервер старше копии расписания: он поднят из архива либо откатан. Сделанное компьютером принимается как факт, остальное сверяется с копией");

  // Своя отметка: слово человека, принятое с сервера, возврат не затирает.
  setStop({ by: "возврат расписания", reason: "расписание возвращается серверу", handback: true });
  const release = await holdRunner(waitMs);
  if (!release) {
    return { code: 1, lines: ["на этом компьютере сейчас идёт проход выпуска: возврат не начат. Новый проход уже не начнётся (местный выпуск остановлен). Дождитесь конца идущего и повторите: npm run mirror -- --handback", "если возврат отменяется и расписание нужно вести дальше: npm run queue -- resume --local"] };
  }
  let failed = 0;
  const sent = { published: 0, handed: 0, partial: 0, cancelled: 0 };
  const row = (res, text) => { lines.push(`${res.code === 0 ? "✓" : "✗"} ${text}${res.code === 0 ? "" : `: ${(res.lines || []).join("; ")}`}`); if (res.code !== 0) failed++; };
  const stray = (res) => {
    if (res.code !== 0) return "";
    if ((res.lines || []).some((l) => /без согласия/.test(l))) return " — БЕЗ СОГЛАСИЯ: на сервере запись была снята или ждала «да». В рабочую группу ушло сообщение";
    if ((res.lines || []).some((l) => /с прежним текстом/.test(l))) return " — ПРЕЖНИЙ ТЕКСТ: на сервере запись исправили и одобрили заново. В рабочую группу ушло сообщение";
    const orphan = (res.lines || []).find((l) => /записи нет на сервере/.test(l));
    if (orphan) return ` — НА СЕРВЕРЕ ЗАПИСИ НЕТ: он поднят из архива старше копии. ${orphan.split(". ").slice(1).join(". ")}`;
    return "";
  };
  let local = new Map();
  const hashOf = (id) => local.get(String(id))?.contentHash || "";
  /* Краткие сведения о записи. Сервер, поднятый из архива, записи может не знать вовсе:
     по этим полям он запишет публикацию в журнал, а не ответит отказом. */
  const brief = (id, r = {}) => {
    const e = local.get(String(id)) || {};
    const [date = "", time = ""] = String(r.slot || "").split(" ");
    return { channel: e.channel || r.channel || "", kind: e.kind || r.kind || "", name: e.name || r.name || "", material: e.material || r.material || "", date: e.date || date, time: e.time || time };
  };
  try {
    // Читается под замком прохода: в эту минуту очередь на компьютере никто не меняет.
    local = latestById(dataPath("queue.jsonl"));
    // Строки, написанные этим компьютером при перехвате. Вышедшее и переданное: по одной на запись.
    const mine = readJsonl(dataPath("ledger.jsonl")).filter((r) => r.takeover);
    const published = new Map();
    const handed = new Map();
    for (const r of mine) {
      if (r.status === "published") published.set(r.id, r);
      else if (r.status === "handed") handed.set(r.id, r);
    }

    for (const r of published.values()) {
      const res = await server("mark", { ref: r.id, link: r.link || "", externalId: r.externalId || "", at: r.at, note: "вышла при перехвате расписания", takeover: true, contentHash: hashOf(r.id), entry: brief(r.id, r) });
      row(res, `${r.channel} · ${r.name}${stray(res)}`);
      if (res.code === 0) sent.published++;
    }
    /* Пакеты на ручную выкладку, ушедшие в группу с компьютера. Серверу их нужно отметить
       переданными, иначе после возврата он отправит тот же пакет второй раз. */
    for (const r of handed.values()) {
      if (published.has(r.id)) continue;
      const e = local.get(String(r.id));
      const res = await server("mark", { ref: r.id, handed: true, packageMessageId: e?.result?.packageMessageId || null, at: r.at, note: "пакет отправлен при перехвате расписания", takeover: true, contentHash: hashOf(r.id), entry: brief(r.id, r) });
      row(res, `${r.channel} · ${r.name} (пакет на ручную выкладку)${stray(res)}`);
      if (res.code === 0) sent.handed++;
    }
    for (const e of local.values()) {
      if (published.has(e.id) || handed.has(e.id)) continue;
      const startedHere = e.startedAt && Date.parse(e.startedAt) >= Date.parse(state.since);
      const fresh = Date.parse(e.at) >= Date.parse(state.since);
      /* Сверка сняла запись уже после того, как с компьютера вышла её часть (согласие
         отозвали либо текст исправили в те минуты, пока ветка ждала повтора). Серверу о
         вышедшей части нужно сказать: иначе после нового «да» он выпустит ветку с первой
         реплики, а вышедшее начало останется на площадке, и никто о нём не узнает. */
      const begun = (e.done?.length ?? 0) > 0 || Boolean(e.result?.tgSending);
      const droppedBySync = e.status === "cancelled" && e.by === SYNC_BY && begun;
      if (startedHere && !e.takeoverHold && (["running", "approved", "failed"].includes(e.status) || droppedBySync)) {
        /* Компьютер запись начал и не закончил: часть ветки вышла либо отправка оборвалась.
           Сервер продолжит с этого места и со сверкой, а не с первой реплики. */
        const res = await server("mark", { ref: e.id, partial: true, done: e.done || [], result: e.result || {}, takeover: true, contentHash: e.contentHash || "", entry: brief(e.id), note: "начата компьютером оператора при перехвате: продолжается со сверкой" });
        row(res, `${e.channel} · ${e.name} (начата и не закончена, вышло частей: ${e.done?.length ?? 0})${stray(res)}`);
        if (res.code === 0) sent.partial++;
      } else if (e.status === "cancelled" && e.by !== SYNC_BY && fresh && ["approved", "failed", "expired"].includes(remote[e.id])) {
        // Оператор снял запись на компьютере по просьбе утверждающего: сервер о снятии не знает.
        const res = await server("cancel", { ref: e.id, reason: `снята на компьютере оператора при перехвате расписания${e.note ? `: ${String(e.note).slice(0, 200)}` : ""}` });
        row(res, `${e.channel} · ${e.name} (снята при перехвате)`);
        if (res.code === 0) sent.cancelled++;
      } else if (e.status === "cancelled" && e.by !== SYNC_BY && fresh && remote[e.id] === "running") {
        // Сервер начал запись до остановки: снять её программа не может, он её допустит.
        lines.push(`! ${e.channel} · ${e.name}: на компьютере снята, а на сервере она «выходит» с минуты до остановки. После возврата сервер сверится с площадкой и допустит её. Откройте площадку: вышедшее убирает владелец аккаунта`);
      }
    }
    /* Сервер поднят из архива старше копии: записей, поставленных после архива, на нём нет.
       Вышедшее записано в его журнал выше. То, что ждало выхода либо согласования, вернуть
       может только человек: согласие на эти записи пропало вместе с сервером. */
    const lost = [...local.values()].filter((e) => remote[e.id] === undefined && !published.has(e.id) && !handed.has(e.id) && !(e.done?.length) && ["draft", "rework", "review", "approved", "failed", "expired"].includes(e.status));
    if (lost.length) {
      lines.push("", `на сервере нет записей, которые есть на компьютере: ${lost.length}. Так бывает, когда сервер поднят из архива старше копии.`);
      for (const e of lost) lines.push(`  ${e.channel} · ${e.name} · ${e.date} ${e.time} · на компьютере «${STATUS_TITLE[e.status] || e.status}»`);
      lines.push("поставьте их заново из файлов записей (npm run queue -- add --file=<файл>) и отправьте на согласование: согласие, данное до аварии, пропало вместе с сервером");
    }
    if (failed) {
      lines.push(`не передано записей: ${failed}. Выпуск на сервере НЕ включён: иначе они выйдут второй раз. Местный выпуск тоже остановлен. Повторите команду`);
      lines.push("если сервер снова лёг и расписание нужно вести дальше: npm run queue -- resume --local");
      return { code: 2, lines };
    }

    /* Сверка с копией: то, что копия знала до перехвата. Записи, которых компьютер не
       касался, идут как есть; записи, придержанные перехватом и так и не разобранные,
       идут в том виде, в каком их знала копия (сервер мог начать их перед остановкой). */
    const since = Date.parse(state.since);
    const fromCopy = [];
    for (const e of local.values()) {
      if (Date.parse(e.at) < since) fromCopy.push(known(e));
      else if (e.status === "failed" && e.takeoverHold && e.heldFrom && e.heldAt) fromCopy.push(known({ ...e, status: e.heldFrom, at: e.heldAt }));
    }
    const rec = await server("reconcile", { entries: fromCopy, copyAt: state.copyFrom || "" }, 60_000);
    if (rec.code !== 0) {
      lines.push(`сверка сервера с копией расписания не прошла: ${(rec.lines || []).join("; ")}. Выпуск на сервере НЕ включён. Повторите команду`);
      return { code: 2, lines };
    }
    const d = rec.data || {};
    const say = (title, list) => { if (list?.length) lines.push(`по копии расписания ${title}: ${list.join(", ")}`); };
    say("отмечены вышедшими", d.closed);
    say("отмечены переданными на ручную выкладку", d.handed);
    say("сняты", d.cancelled);
    say("лишились согласия и ждут нового «да»", d.withdrawn);
    say("получили отметку о начатой отправке", d.progressed);
    say("переставлены на слот из копии", d.moved);
    say("записаны в журнал сервера", d.logged);

    // handback: остановку ради перехвата сервер снимает только этой командой.
    const resumed = await server("resume", { handback: true });
    if (resumed.code !== 0) {
      if (resumed.network) {
        /* Ответ на последний запрос не пришёл. Сервер мог его исполнить и уже выпускает:
           считать, что он стоит, нельзя. Выпуск на компьютере не продолжится, пока сервер
           не подтвердит отметку перехвата либо оператор не скажет, что сервер остановлен. */
        writeJson(dataPath("TAKEOVER.json"), { ...state, serverMayRun: true });
        lines.push("всё передано, но ответ на последний запрос не пришёл: неизвестно, включил ли сервер выпуск. Считайте, что включил. Выпуск на этом компьютере остановлен и сам не продолжится");
        lines.push("связь вернулась: повторите npm run mirror -- --handback, команда закончит возврат");
        lines.push("сервер лежит либо выпуск на нём остановлен, а расписание нужно вести дальше: npm run queue -- resume --local --server-stopped");
        return { code: 2, lines };
      }
      lines.push(`всё передано, но отметка перехвата на сервере не снята: ${(resumed.lines || []).join("; ")}. Повторите команду`);
      return { code: 2, lines };
    }
    rmSync(dataPath("TAKEOVER.json"));
    lines.push(`серверу передано: вышедших ${sent.published}, пакетов на ручную выкладку ${sent.handed}, начатых и не законченных ${sent.partial}, снятых ${sent.cancelled}`);
    lines.push(...(resumed.lines || []).map((l) => `сервер: ${l}`));
    lines.push("местный выпуск остановлен. Выключите задачу «zavod-takeover» в планировщике");
    return { code: 0, lines };
  } finally {
    release();
  }
}

/**
 * Сверить сервер с копией расписания. Нужна после восстановления сервера из архива либо
 * из снимка диска, когда расписание компьютер не перехватывал.
 *
 * Архив снимается раз в сутки, копия раз в четверть часа. Сервер из архива не знает, что
 * вышло, что сняли и чему отозвали согласие после архива, и выпустил бы всё это заново.
 * Сверка только закрывает и придерживает: согласие из копии она не восстанавливает.
 */
export async function reconcile() {
  if (isTakeover()) return { code: 1, lines: ["расписание сейчас ведёт этот компьютер: сверку с копией делает возврат, npm run mirror -- --handback"] };
  /* Копии нет: сверять не с чем. Отметку «восстановлен из архива» в этом случае снимает
     только осознанное подтверждение: сервер пойдёт по расписанию из архива, и вышедшее
     после архива выйдет второй раз. */
  if (!existsSync(mirrorPath("queue.json")) && !flag("no-copy")) return { code: 2, lines: ["копии расписания нет (mirror/queue.json): сверять не с чем", "если копии нет и не будет, сервер можно пустить по расписанию из архива. Сначала посмотрите площадки глазами: что вышло после архива, отметьте (npm run queue -- mark <имя> --channel=<площадка> --link=<ссылка>), снятое снимите. Потом: npm run mirror -- --reconcile --no-copy"] };
  const copy = existsSync(mirrorPath("queue.json")) ? readJson(mirrorPath("queue.json"), []) || [] : [];
  const state = readJson(mirrorPath("state.json"), {}) || {};
  const res = await server("reconcile", { entries: copy.map(known), stoppedByHuman: Boolean(state.stoppedByHuman), copyAt: state.pulledAt || "" }, 60_000);
  if (res.code !== 0) return { code: res.code || 2, lines: [...(res.lines || []), "сверка не прошла: выпуск на сервере остаётся как был. Копия не тронута"] };
  // Сверка прошла: следующая копия снимается обычным порядком.
  const { rolledBackAt, serverRestored, ...rest } = state;
  writeJson(mirrorPath("state.json"), rest);
  rmSync(mirrorPath("rollback"), { recursive: true, force: true });
  resolve("server:rolledback");
  return { code: 0, lines: [`сервер сверен с копией расписания${state.pulledAt ? ` от ${stamp(state.pulledAt)}` : ""}`, ...(res.lines || []), "снимите свежую копию: npm run mirror"] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let code = 0;
  try {
    if (flag("takeover")) { const r = await takeover(); r.lines.forEach((l) => console.log(l)); code = r.code; }
    else if (flag("handback")) { const r = await handback(); r.lines.forEach((l) => console.log(l)); code = r.code; }
    else if (flag("reconcile")) { const r = await reconcile(); r.lines.forEach((l) => console.log(l)); code = r.code; }
    else if (flag("watch")) {
      const copy = await pull();
      // Когда сервер перестал отдавать копию: по этой отметке перехват называет слепое окно.
      if (!copy.ok && !copy.rolledBack) { const st = readJson(mirrorPath("state.json"), null); if (st && !st.failSince) writeJson(mirrorPath("state.json"), { ...st, failSince: new Date().toISOString() }); }
      if (copy.rolledBack) await rolledBack();
      const r = await watch();
      if (!r.ok || !copy.ok) console.log(`${new Date().toISOString()} сторож: ${r.ok ? "сервер жив" : r.text}${copy.ok ? "" : `; копия не снята: ${copy.error}`}`);
      code = r.ok && !copy.rolledBack ? 0 : 1;
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
