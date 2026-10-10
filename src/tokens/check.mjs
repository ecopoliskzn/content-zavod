#!/usr/bin/env node
// Ключи площадок: сроки, продление, сверка копий. Cron на сервере раз в сутки:
//   0 3 * * * node /opt/ecopolis-zavod/current/src/tokens/check.mjs --refresh --live
//
//   npm run tokens                    таблица: какие ключи заданы и сколько им осталось
//   npm run tokens -- --live          спросить площадки, живы ли ключи
//   npm run tokens -- --refresh       продлить маркеры Threads и Instagram, которым осталось меньше 20 дней
//   npm run tokens -- --compare       сверить копии ключей на компьютере и на сервере (по отпечаткам)
//
// ЗНАЧЕНИЯ КЛЮЧЕЙ НЕ ПЕЧАТАЮТСЯ НИКОГДА. В таблице имя, срок и статус; при сверке —
// короткий отпечаток, по которому значение не восстановить.
//
// Что известно про сроки:
//  · маркеры Threads и Instagram живут 60 дней. Продлить можно маркер старше суток и ещё
//    не истёкший. Истёкший не продлевается ничем: владелец аккаунта входит заново;
//  · после продления маркера Instagram подписку аккаунта на события нужно оформить
//    заново, иначе кодовые слова молча перестают работать. Скрипт делает это сам;
//  · ключ обновления YouTube не истекает, пока приложение Google в статусе «В продакшене».
//    В статусе «Тестирование» он живёт 7 дней;
//  · ключи ВКонтакте и Rutube бессрочные, но отзываются при смене пароля владельцем.
//
// ТРИ ИСХОДА ПРОВЕРКИ. «Площадка отказала» и «не смог спросить» — разные вещи. Тревога
// уходит только на отказ: сетевой сбой не объявляет ключ мёртвым.

import { fileURLToPath } from "node:url";
import { env, envFile, fingerprint, has } from "../lib/env.mjs";
import { setEnv } from "../lib/envfile.mjs";
import { request } from "../lib/http.mjs";
import { alert, resolve } from "../lib/notify.mjs";
import { tg } from "../lib/telegram.mjs";
import { mskDate } from "../lib/time.mjs";
import { adapter } from "../channels/index.mjs";
import { REGISTRY, secrets } from "./registry.mjs";

const flag = (name) => process.argv.includes(`--${name}`);
const REFRESH_BELOW_DAYS = 20;

/** Случайные секреты, которые завод придумывает сам. Создаются только отсутствующие. */
const GENERATED = ["ADMIN_API_TOKEN", "TG_RELAY_SECRET", "TG_WEBHOOK_SECRET", "IG_RELAY_SECRET", "IG_FORWARD_SECRET", "IG_WEBHOOK_VERIFY_TOKEN"];

/** npm run tokens -- --init: создать недостающие секреты. Значения не печатаются. */
export async function init() {
  const { randomBytes } = await import("node:crypto");
  const fresh = Object.fromEntries(GENERATED.filter((n) => !has(n)).map((n) => [n, randomBytes(32).toString("hex")]));
  if (!Object.keys(fresh).length) return { file: envFile(), created: [] };
  return { file: setEnv(fresh), created: Object.keys(fresh) };
}

/** Сколько дней осталось до даты (ГГГГ-ММ-ДД или ISO). Нет даты — null. */
export function daysLeft(value, now = Date.now()) {
  const t = Date.parse(String(value || "").length === 10 ? `${value}T00:00:00+03:00` : value);
  return Number.isFinite(t) ? Math.floor((t - now) / 86_400_000) : null;
}

/** Таблица ключей без сети: что задано и что скоро истечёт. Чистая по отношению к сети. */
export function table(now = Date.now()) {
  return REGISTRY.filter((r) => r.secret || r.expires).map((r) => {
    const set = has(r.name);
    const left = r.expires ? daysLeft(env(r.expires), now) : null;
    let status = set ? "задан" : "не задан";
    if (set && r.expires) status = left === null ? "задан, срок неизвестен" : left < 0 ? "ИСТЁК" : left <= 7 ? `истекает через ${left} дн.` : `ещё ${left} дн.`;
    return { name: r.name, set, daysLeft: left, status, need: r.need, where: r.where };
  });
}

/** Живая проверка площадок. Возвращает строки { channel, kind, detail }. */
export async function live() {
  const out = [];
  const me = await tg("getMe");
  out.push({ channel: "telegram-бот", kind: me.kind, detail: me.kind === "ok" ? `@${me.result?.username}` : me.error });
  const checks = [
    ["telegram", "TG_CHANNEL", async (m) => m.probe()],
    ["threads", "THREADS_TOKEN", async (m) => { const r = await m.me(); return r.kind === "ok" ? { kind: "ok", detail: `@${r.username}` } : r; }],
    ["instagram", "IG_TOKEN", async (m) => m.probe()],
    ["vk", "VK_GROUP_TOKEN", async (m) => m.probe()],
    ["youtube", "YOUTUBE_REFRESH_TOKEN", async (m) => m.probe()],
    ["rutube", "RUTUBE_TOKEN", async (m) => m.probe()],
  ];
  for (const [channel, key, run] of checks) {
    if (!has(key)) { out.push({ channel, kind: "skip", detail: `не подключена (нет ${key})` }); continue; }
    try {
      const mod = await adapter(channel);
      const r = await run(mod);
      out.push({ channel, kind: r.kind, detail: r.kind === "ok" ? r.detail || "ключ жив" : r.error });
    } catch (e) {
      out.push({ channel, kind: "network", detail: `сбой проверки: ${e?.message || e}` });
    }
  }
  return out;
}

/** Продление маркеров Threads и Instagram. */
export async function refresh({ force = false, now = Date.now() } = {}) {
  const out = [];
  const jobs = [
    { channel: "threads", token: "THREADS_TOKEN", expires: "THREADS_TOKEN_EXPIRES" },
    { channel: "instagram", token: "IG_TOKEN", expires: "IG_TOKEN_EXPIRES" },
  ];
  for (const job of jobs) {
    if (!has(job.token)) continue;
    const left = daysLeft(env(job.expires), now);
    if (!force && left !== null && left > REFRESH_BELOW_DAYS) { out.push({ channel: job.channel, action: "рано", daysLeft: left }); continue; }
    if (left !== null && left < 0) { out.push({ channel: job.channel, action: "истёк", daysLeft: left }); continue; }
    const mod = await adapter(job.channel);
    const r = await mod.refreshToken();
    if (r.kind !== "ok") { out.push({ channel: job.channel, action: r.kind === "network" ? "сеть" : "отказ", error: r.error, daysLeft: left }); continue; }
    const until = mskDate(now + (r.expiresInSec || 60 * 86_400) * 1000);
    setEnv({ [job.token]: r.token, [job.expires]: until });
    let note = "";
    if (job.channel === "instagram") {
      // Подписка на события слетает при перевыпуске маркера: оформляем заново сразу.
      const sub = await mod.subscribe();
      note = sub.kind === "ok" ? ", подписка на события оформлена заново" : `, ПОДПИСКА НА СОБЫТИЯ НЕ ОФОРМИЛАСЬ: ${sub.error}`;
    }
    out.push({ channel: job.channel, action: "продлён", until, note });
  }
  return out;
}

/** Отпечатки секретов этой машины: имя → 8 знаков. */
export function fingerprints() {
  return Object.fromEntries(secrets().filter((n) => has(n)).map((n) => [n, fingerprint(n)]));
}

/** Сверка копий ключей: компьютер против сервера. */
export async function compare() {
  const base = env("QUEUE_API_BASE").replace(/\/+$/, "");
  if (!base) return { code: 2, lines: ["нет QUEUE_API_BASE: сверять не с чем"] };
  const res = await request(`${base}/admin/queue`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env("ADMIN_API_TOKEN")}` }, body: JSON.stringify({ cmd: "keys", args: {}, actor: "сверка ключей" }), timeoutMs: 30_000 });
  if (res.kind !== "ok" || !res.data?.data) return { code: 2, lines: [`сервер не ответил: ${res.error || (res.data?.lines || []).join("; ")}`] };
  const remote = res.data.data;
  const local = fingerprints();
  const lines = [];
  let differ = 0;
  for (const r of REGISTRY.filter((x) => x.secret && x.where.includes("server") && x.where.includes("operator"))) {
    const a = local[r.name];
    const b = remote[r.name];
    if (!a && !b) continue;
    if (a && b && a === b) { lines.push(`✓ ${r.name}`); continue; }
    differ++;
    lines.push(`✗ ${r.name}: ${!a ? "на компьютере нет" : !b ? "на сервере нет" : "значения разные"}`);
  }
  lines.push(differ ? `расходятся: ${differ}. Хозяин значения — сервер (маркеры продлеваются там). Скопируйте файл окружения с сервера заново` : "копии ключей совпадают");
  return { code: differ ? 1 : 0, lines };
}

async function main() {
  if (flag("init")) {
    const r = await init();
    console.log(r.created.length ? `созданы в ${r.file}: ${r.created.join(", ")}` : "все случайные секреты уже заданы");
    return 0;
  }
  if (flag("compare")) {
    const r = await compare();
    r.lines.forEach((l) => console.log(l));
    return r.code;
  }
  let code = 0;
  console.log(`файл окружения: ${envFile() || "не найден"}`);
  if (flag("refresh")) {
    for (const r of await refresh({ force: flag("force") })) {
      if (r.action === "продлён") { console.log(`✓ ${r.channel}: маркер продлён до ${r.until}${r.note}`); resolve(`token:${r.channel}`); }
      else if (r.action === "рано") console.log(`· ${r.channel}: ещё ${r.daysLeft} дн., продлевать рано`);
      else if (r.action === "сеть") console.log(`⚠ ${r.channel}: не дозвонились (${r.error}), попробуем завтра`);
      else {
        code = 1;
        console.log(`✗ ${r.channel}: ${r.action}${r.error ? ` (${r.error})` : ""}`);
        await alert(`token:${r.channel}`, `Маркер площадки ${r.channel} ${r.action === "истёк" ? "истёк" : "не продлевается"}${r.error ? `: ${r.error}` : ""}. Выпуск на эту площадку ${r.action === "истёк" ? "остановлен" : "остановится, когда маркер истечёт"}.`, { action: "перешлите это сообщение оператору: владельцу аккаунта нужно один раз войти заново по ссылке, которую пришлёт оператор" });
      }
      if (r.note && r.note.includes("НЕ ОФОРМИЛАСЬ")) {
        code = 1;
        await alert("token:instagram:subscribe", "Маркер Instagram продлён, но подписка аккаунта на события не оформилась. Кодовые слова в комментариях и директе не сработают.", { action: "перешлите это сообщение оператору" });
      }
    }
  }
  for (const row of table()) {
    if (!row.set && row.need === "optional") continue;
    const mark = !row.set ? "·" : row.daysLeft !== null && row.daysLeft < 0 ? "✗" : row.daysLeft !== null && row.daysLeft <= 7 ? "⚠" : "✓";
    console.log(`${mark} ${row.name.padEnd(26)} ${row.status}`);
    if (row.daysLeft !== null && row.daysLeft <= 7 && row.set) code = Math.max(code, 1);
  }
  if (flag("live")) {
    console.log("");
    for (const r of await live()) {
      const mark = r.kind === "ok" ? "✓" : r.kind === "skip" ? "·" : r.kind === "network" ? "⚠" : "✗";
      console.log(`${mark} ${r.channel.padEnd(14)} ${r.detail}`);
      if (r.kind === "refused") {
        code = Math.max(code, 1);
        await alert(`live:${r.channel}`, `Площадка ${r.channel} отвергла ключ: ${r.detail}`, { action: "перешлите это сообщение оператору: ключ нужно выдать заново" });
      } else if (r.kind === "ok") resolve(`live:${r.channel}`);
    }
  }
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`сбой проверки ключей: ${e?.stack || e}`); process.exitCode = 2; });
}
