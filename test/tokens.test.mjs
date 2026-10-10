// Ключи: вход владельца аккаунта в Meta и перенос ключей между машинами файлом.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(os.tmpdir(), "zavod-tokens-"));
const ENV = path.join(DIR, "test.env");
const IG = "IGAAtestTokenValue0123456789abcdefghijklmnop";
writeFileSync(ENV, `PUBLIC_BASE_URL=https://go.example.ru\nIG_TOKEN=${IG}\nIG_USER_ID=17841400000000099\nMETA_IG_APP_SECRET=appsecret-0123456789\nTHREADS_TOKEN=\n`);
process.env.ZAVOD_ENV_FILE = ENV;
process.env.DATA_DIR = DIR;
for (const k of ["IG_TOKEN", "IG_USER_ID", "IG_TOKEN_EXPIRES", "THREADS_TOKEN", "META_IG_APP_SECRET", "PUBLIC_BASE_URL"]) delete process.env[k];

const { PLATFORMS, authorizeUrl, cleanCode, expiresOn, scrub } = await import("../src/tokens/meta-login.mjs");
const { exportKeys, importKeys, machine } = await import("../src/tokens/check.mjs");
const { REGISTRY } = await import("../src/tokens/registry.mjs");

test("ссылка входа: своя площадка, все права сразу, код в ответе", () => {
  const ig = new URL(authorizeUrl("instagram", { appId: "123", redirect: "https://example.ru/cb" }));
  assert.equal(ig.origin + ig.pathname, "https://www.instagram.com/oauth/authorize");
  assert.equal(ig.searchParams.get("client_id"), "123");
  assert.equal(ig.searchParams.get("redirect_uri"), "https://example.ru/cb");
  assert.equal(ig.searchParams.get("response_type"), "code");
  // Задним числом право к маркеру не добавить: публикация, комментарии, сообщения и цифры берутся разом.
  assert.deepEqual(ig.searchParams.get("scope").split(","), ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments", "instagram_business_manage_messages", "instagram_business_manage_insights"]);
  const th = new URL(authorizeUrl("threads", { appId: "456", redirect: "https://example.ru/cb" }));
  assert.equal(th.host, "threads.net");
  assert.ok(th.searchParams.get("scope").includes("threads_content_publish"));
  assert.ok(th.searchParams.get("scope").includes("threads_read_replies"));
});

test("код со страницы возврата чистится от хвоста и пробелов", () => {
  assert.equal(cleanCode("  AQBx-123_abc#_ "), "AQBx-123_abc");
  assert.equal(cleanCode("AQBx"), "AQBx");
  assert.equal(cleanCode(undefined), "");
});

test("секрет из текста ошибки вычищается, короткие совпадения не трогаются", () => {
  assert.equal(scrub(`Invalid OAuth access token ${IG} for app`, IG), "Invalid OAuth access token «скрыто» for app");
  assert.equal(scrub("код 190", "19"), "код 190", "двухзначный «секрет» вырезал бы полстроки");
  assert.equal(scrub("x".repeat(500)).length, 300);
});

test("срок маркера: день по Москве, шестьдесят дней по умолчанию", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(expiresOn(5_184_000, now), "2026-12-09");
  assert.equal(expiresOn(undefined, now), "2026-12-09");
  // 22:30 по Гринвичу — это уже следующий день в Москве.
  assert.equal(expiresOn(86_400, Date.parse("2026-10-10T22:30:00Z")), "2026-10-12");
});

test("имена ключей площадок Meta есть в реестре, секрет приложения на сервер не кладётся", () => {
  const byName = new Map(REGISTRY.map((r) => [r.name, r]));
  for (const p of Object.values(PLATFORMS)) {
    for (const name of [p.appId, p.appSecret, p.redirect, ...Object.values(p.keys)]) assert.ok(byName.has(name), `переменной ${name} нет в реестре`);
    assert.deepEqual(byName.get(p.appSecret).where, ["operator"], `${p.appSecret}: секрет приложения живёт только у оператора`);
    assert.equal(byName.get(p.appSecret).secret, true);
    assert.ok(byName.get(p.keys.token).where.includes("server"));
  }
});

test("выгрузка ключей: значения уходят в файл, а не на экран; незаданное названо", () => {
  assert.equal(machine(), "operator");
  const out = path.join(DIR, "keys.env");
  const r = exportKeys(["IG_TOKEN", "IG_USER_ID", "THREADS_TOKEN"], out);
  assert.deepEqual(r.written, ["IG_TOKEN", "IG_USER_ID"]);
  assert.deepEqual(r.missing, ["THREADS_TOKEN"]);
  assert.equal(readFileSync(out, "utf8"), `IG_TOKEN=${IG}\nIG_USER_ID=17841400000000099\n`);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(IG), "в ответе команды значений нет");
  assert.throws(() => exportKeys(["NET_TAKOJ"], out), (e) => e.code === "RULE" && /нет в реестре/.test(e.message));
  assert.throws(() => exportKeys(["IG_TOKEN"], ""), (e) => e.code === "RULE");
});

test("приём ключей на сервере: чужой секрет останавливает приём целиком", () => {
  const before = readFileSync(ENV, "utf8");
  const bad = path.join(DIR, "bad.env");
  writeFileSync(bad, "IG_TOKEN=IGAAnewValue\nMETA_IG_APP_SECRET=чужой-секрет-приложения\n");
  assert.throws(() => importKeys(bad, "server"), (e) => e.code === "RULE" && /этим ключам здесь не место \(сервер\): META_IG_APP_SECRET/.test(e.message));
  assert.equal(readFileSync(ENV, "utf8"), before, "файл окружения не тронут");
  assert.ok(existsSync(bad), "непринятый файл остаётся: его правят и приносят заново");

  const unknown = path.join(DIR, "unknown.env");
  writeFileSync(unknown, "SOME_OTHER_KEY=1\n");
  assert.throws(() => importKeys(unknown, "server"), (e) => /неизвестные переменные: SOME_OTHER_KEY/.test(e.message));
  writeFileSync(unknown, "# только комментарий\n");
  assert.throws(() => importKeys(unknown, "server"), (e) => /нет ни одной строки/.test(e.message));
  assert.throws(() => importKeys(path.join(DIR, "нет.env"), "server"), (e) => e.code === "RULE");
});

test("приём ключей: строки вписаны в файл окружения, принесённый файл удалён", () => {
  const good = path.join(DIR, "good.env");
  writeFileSync(good, "﻿IG_TOKEN=IGAAfreshTokenValue0123456789\r\nIG_TOKEN_EXPIRES=2026-12-09\r\nIG_USERNAME=ecopolis_kzn\r\n");
  const r = importKeys(good, "server");
  assert.deepEqual(r.names, ["IG_TOKEN", "IG_TOKEN_EXPIRES", "IG_USERNAME"]);
  assert.equal(existsSync(good), false);
  const text = readFileSync(ENV, "utf8");
  assert.match(text, /^IG_TOKEN=IGAAfreshTokenValue0123456789$/m);
  assert.match(text, /^IG_TOKEN_EXPIRES=2026-12-09$/m);
  assert.match(text, /^IG_USER_ID=17841400000000099$/m, "соседние строки не задеты");
  assert.doesNotMatch(text, new RegExp(IG), "старое значение заменено, а не дописано вторым");
  assert.equal((text.match(/^IG_TOKEN=/gm) || []).length, 1);
});

test("файл окружения, названный явно, единственный: если его нет, соседний .env.local не читается и не пишется", async () => {
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(path.join(os.tmpdir(), "zavod-envdir-"));
  // Так выглядит компьютер оператора: в каталоге запуска лежит боевой файл с ключами.
  writeFileSync(path.join(dir, ".env.local"), "PROBE_KEY=из-боевого-файла\n");
  const envModule = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "env.mjs")).href;
  const code = `import { env, envTarget } from ${JSON.stringify(envModule)}; console.log(JSON.stringify([env("PROBE_KEY"), envTarget()]));`;
  const base = { ...process.env };
  delete base.ZAVOD_ENV_FILE;
  delete base.PROBE_KEY;
  const run = (extra) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: dir, env: { ...base, ...extra }, encoding: "utf8" }));
  // Тест назвал несуществующий файл, чтобы отгородиться от настоящих ключей.
  const missing = path.join(dir, "нет-такого.env");
  assert.deepEqual(run({ ZAVOD_ENV_FILE: missing }), ["", missing]);
  // Без явного файла всё по-прежнему: читается файл из каталога запуска, в него же и пишется.
  const [value, target] = run({});
  assert.equal(value, "из-боевого-файла");
  assert.equal(path.basename(target), ".env.local");
});

test("пока своего приложения Meta нет, аккаунт Instagram на события не подписывается", async () => {
  const instagram = await import("../src/channels/instagram.mjs");
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}", { status: 200 }); };
  delete process.env.IG_APP_SECRET;
  try {
    // Маркер выдан чужим приложением: события ушли бы на его сервер.
    const sub = await instagram.subscribe();
    assert.equal(sub.kind, "skipped");
    assert.equal(calls, 0, "запрос на подписку не уходит вовсе");
  } finally {
    globalThis.fetch = real;
  }
});
