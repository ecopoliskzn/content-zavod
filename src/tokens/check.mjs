#!/usr/bin/env node
// Ключи площадок: сроки, продление, сверка копий. Cron на сервере раз в сутки:
//   0 3 * * * node /opt/ecopolis-zavod/current/src/tokens/check.mjs --refresh --live
//
//   npm run tokens                    таблица: какие ключи заданы и сколько им осталось
//   npm run tokens -- --live          спросить площадки, живы ли ключи
//   npm run tokens -- --refresh       продлить маркеры Threads и Instagram, которым осталось меньше 20 дней
//   npm run tokens -- --compare       сверить копии ключей на компьютере и на сервере (по отпечаткам)
//   npm run tokens -- --init          создать недостающие случайные секреты (на сервере, один раз)
//   npm run tokens -- --export=ИМЯ,ИМЯ --out=keys.env   выгрузить ключи в файл для переноса
//   npm run tokens -- --import=/tmp/keys.env            принять файл с ключами и удалить его
//   npm run tokens -- --example       напечатать образец файла окружения из реестра
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

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env, envFile, fingerprint, has, wrongUser } from "../lib/env.mjs";
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

/**
 * На какой машине мы: сервер читает файл окружения из /opt, компьютер оператора из проекта.
 * От этого зависит, какие ключи здесь вообще могут лежать.
 */
export const machine = () => (String(envFile()).startsWith("/opt/") || env("DATA_DIR").startsWith("/opt/") ? "server" : "operator");

/**
 * Выгрузка выбранных ключей в файл для переноса на другую машину. Значения не печатаются.
 * Ключи переносятся файлом, из терминала в терминал: в чат, письмо, буфер обмена и
 * сессию Codex значение не попадает ни разу.
 * @returns {{ written: string[], missing: string[], file: string }}
 */
export function exportKeys(names, outFile) {
  const known = new Map(REGISTRY.map((r) => [r.name, r]));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) throw Object.assign(new Error(`таких переменных нет в реестре: ${unknown.join(", ")}`), { code: "RULE" });
  if (!outFile) throw Object.assign(new Error("куда выгрузить: --out=<файл>"), { code: "RULE" });
  const written = names.filter(has);
  writeFileSync(outFile, written.map((n) => `${n}=${env(n)}`).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  return { written, missing: names.filter((n) => !has(n)), file: outFile };
}

/**
 * Приём файла с ключами: строки вписываются в файл окружения этой машины, принесённый файл
 * удаляется. Ключ, которому на этой машине не место, останавливает приём целиком: так
 * секрет приложения Meta исполнителя не окажется на сервере клиента по ошибке.
 * @returns {{ names: string[], file: string }}
 */
export function importKeys(file, where = machine()) {
  if (!existsSync(file)) throw Object.assign(new Error(`файла ${file} нет`), { code: "RULE" });
  const known = new Map(REGISTRY.map((r) => [r.name, r]));
  const values = {};
  for (const line of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    values[m[1]] = m[2].trim();
  }
  const names = Object.keys(values);
  if (!names.length) throw Object.assign(new Error("в файле нет ни одной строки ИМЯ=значение"), { code: "RULE" });
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) throw Object.assign(new Error(`неизвестные переменные: ${unknown.join(", ")}. Файл не принят`), { code: "RULE" });
  const foreign = names.filter((n) => !known.get(n).where.includes(where));
  if (foreign.length) throw Object.assign(new Error(`этим ключам здесь не место (${where === "server" ? "сервер" : "компьютер оператора"}): ${foreign.join(", ")}. Файл не принят и не удалён: уберите лишние строки`), { code: "RULE" });
  const target = setEnv(values);
  rmSync(file);
  return { names, file: target };
}

const SECTIONS = [
  ["Общее", (n) => ["DATA_DIR", "PUBLIC_BASE_URL", "PORT", "ADMIN_API_TOKEN", "QUEUE_API_BASE", "OPERATOR_NAME", "MIRROR_DIR"].includes(n)],
  ["Telegram: бот, рабочая группа, канал", (n) => n.startsWith("TG_") || n === "APPROVER_IDS" || n === "STAFF_IDS"],
  ["Threads", (n) => n.startsWith("THREADS_")],
  ["Instagram", (n) => n.startsWith("IG_")],
  ["Приложение Meta: вход владельца аккаунта", (n) => n.startsWith("META_")],
  ["ВКонтакте", (n) => n.startsWith("VK_")],
  ["YouTube", (n) => n.startsWith("YOUTUBE_")],
  ["Rutube", (n) => n.startsWith("RUTUBE_")],
  ["Хранилище файлов", (n) => n.startsWith("S3_")],
  ["Резервные копии", (n) => n.startsWith("BACKUP_")],
  ["Заявки и документы", () => true],
];
const WHERE = { server: "сервер", operator: "компьютер", relay: "релей" };

/**
 * Образец файла окружения: имена и пояснения из реестра, значений нет.
 * Файл .env.example в корне проекта собирается этой функцией и сверяется с ней тестом:
 * переменная, добавленная в реестр, не может остаться без строки в образце.
 */
export function example(channelTitles = {}) {
  const need = (r) => (r.need === "core" ? "обязательна" : r.need.startsWith("channel:") ? `нужна для площадки «${channelTitles[r.need.slice(8)] || r.need.slice(8)}»` : "по желанию");
  const out = [
    "# Образец файла окружения завода. Собран из src/tokens/registry.mjs:",
    "#   npm run tokens -- --example > .env.example",
    "# Значений здесь нет и быть не должно. Настоящие файлы в git не попадают:",
    "#   сервер                /opt/ecopolis-data/.env   (права 600, владелец zavod)",
    "#   компьютер оператора   .env.local в корне проекта",
    "#   релей                 /etc/zavod-relay.env на втором сервере либо секреты Cloudflare",
    "# После пояснения в квадратных скобках: на каких машинах переменная нужна.",
    `# Случайные секреты (${GENERATED.join(", ")}) создаёт`,
    "# команда на сервере: node src/tokens/check.mjs --init. Руками их не придумывают.",
    "# Значение ключа нельзя показывать никому и ничему: ни в чате, ни в выводе команды.",
  ];
  const left = [...REGISTRY];
  for (const [title, test] of SECTIONS) {
    const mine = left.filter((r) => test(r.name));
    if (!mine.length) continue;
    for (const r of mine) left.splice(left.indexOf(r), 1);
    out.push("", `# ── ${title} ${"─".repeat(Math.max(3, 66 - title.length))}`);
    for (const r of mine) out.push(`# ${r.what}`, `# [${r.where.map((w) => WHERE[w] || w).join(", ")}] · ${need(r)}${r.secret ? " · секрет" : ""}`, `${r.name}=`, "");
    out.pop();
  }
  out.push(
    "",
    `# ── Только релей ${"─".repeat(54)}`,
    "# адрес сервера завода с https://: туда релей передаёт обновления Telegram",
    "# [релей] · обязательна",
    "ORIGIN_URL=",
    "# порт релея на втором сервере, по умолчанию 8787 (слушает только 127.0.0.1)",
    "# [релей] · по желанию",
    "RELAY_PORT=",
    "",
  );
  return out.join("\n");
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
  const toPc = [];
  const toServer = [];
  const unclear = [];
  for (const r of REGISTRY.filter((x) => x.secret && x.where.includes("server") && x.where.includes("operator"))) {
    const a = local[r.name];
    const b = remote[r.name];
    if (!a && !b) continue;
    if (a && b && a === b) { lines.push(`✓ ${r.name}`); continue; }
    lines.push(`✗ ${r.name}: ${!a ? "на компьютере нет" : !b ? "на сервере нет" : "значения разные"}`);
    /* Куда нести. Ключ есть на одной стороне — несём с неё. Значения разные:
       маркер со сроком продлевает сервер, и копия на компьютере стареет молча;
       ключ YouTube выдаётся входом владельца канала на компьютере оператора;
       про остальные по отпечатку не понять, какое значение рабочее. */
    if (a && !b) toServer.push(r.name);
    else if (!a && b) toPc.push(r.name);
    else if (r.expires) toPc.push(r.name);
    else if (r.name === "YOUTUBE_REFRESH_TOKEN") toServer.push(r.name);
    else unclear.push(r.name);
  }
  if (!toPc.length && !toServer.length && !unclear.length) { lines.push("копии ключей совпадают"); return { code: 0, lines }; }
  /* Файл окружения целиком не копируется никогда: на сервере лежат ключи, которым не
     место на компьютере, и наоборот (src/tokens/registry.mjs, поле where). Ключи несут
     по именам, командами выгрузки и приёма: значение при этом не появляется на экране. */
  lines.push(`расходятся: ${toPc.length + toServer.length + unclear.length}`);
  if (toPc.length) lines.push(`с сервера на компьютер. На сервере: npm run tokens -- --export=${toPc.join(",")} --out=keys.tmp · перенести файл по scp · здесь: npm run tokens -- --import=keys.tmp`);
  if (toServer.length) lines.push(`с компьютера на сервер. Здесь: npm run tokens -- --export=${toServer.join(",")} --out=keys.tmp · перенести файл по scp · на сервере: npm run tokens -- --import=keys.tmp`);
  if (unclear.length) lines.push(`значения разные, и по отпечатку не видно, какое рабочее: ${unclear.join(", ")}. Проверьте живым вызовом на обеих машинах (npm run doctor -- --live) и перенесите рабочее теми же командами`);
  lines.push("принесённый файл после приёма удаляется сам; оригинал на стороне выгрузки удалите руками");
  return { code: 1, lines };
}

async function main() {
  if (flag("example")) {
    const { config } = await import("../lib/config.mjs");
    process.stdout.write(example(Object.fromEntries(Object.entries(config().channels || {}).map(([k, v]) => [k, v.title]))));
    return 0;
  }
  // Создание секретов, приём и продление ключей переписывают файл окружения: под чужим
  // пользователем он станет недоступен заводу.
  const foreign = wrongUser();
  if (foreign && process.argv.some((a) => a === "--init" || a === "--refresh" || a.startsWith("--import="))) { console.error(`✗ ${foreign}`); return 1; }
  if (flag("init")) {
    const r = await init();
    console.log(r.created.length ? `созданы в ${r.file}: ${r.created.join(", ")}` : "все случайные секреты уже заданы");
    return 0;
  }
  const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
  if (opt("export")) {
    try {
      const r = exportKeys(opt("export").split(",").map((s) => s.trim()).filter(Boolean), opt("out"));
      console.log(`выгружено в ${r.file}: ${r.written.join(", ") || "ничего"}${r.missing.length ? `\nне заданы и не выгружены: ${r.missing.join(", ")}` : ""}`);
      console.log("Файл с ключами: перенесите его по scp, примите на той стороне (--import) и удалите здесь.");
      return r.written.length ? 0 : 1;
    } catch (e) { console.error(`✗ ${e.message}`); return e.code === "RULE" ? 1 : 2; }
  }
  if (opt("import")) {
    try {
      const r = importKeys(opt("import"));
      console.log(`приняты в ${r.file}: ${r.names.join(", ")}. Принесённый файл удалён.`);
      if (r.names.includes("IG_TOKEN")) {
        // Новый маркер Instagram без подписки на события нем: кодовые слова молча не работают.
        const sub = await (await adapter("instagram")).subscribe();
        console.log(sub.kind === "ok" ? "✓ подписка аккаунта Instagram на события оформлена" : `⚠ подписка на события не оформилась: ${sub.error}. Повторите: node src/tokens/check.mjs --refresh --force`);
      }
      return 0;
    } catch (e) { console.error(`✗ ${e.message}`); return e.code === "RULE" ? 1 : 2; }
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
