#!/usr/bin/env node
// Доктор: одна команда, которая говорит, что готово, а что нет. Запускается первой в
// каждой сессии и после любой замены ключа.
//
//   npm run doctor                 без сети: окружение, файлы бота, реестр, каталог данных
//   npm run doctor -- --live       плюс живые вызовы: релей, группа, площадки, сервер
//   npm run doctor -- --media      плюс проверка хранилища: загрузить файл и забрать его снаружи
//   npm run doctor -- --where=server|operator   какую машину проверяем (по умолчанию определяется сам)
//
// Коды выхода: 0 всё готово · 1 есть что чинить · 2 доктор сам не смог отработать.
//
// ПРАВИЛО ВЫВОДА. Каждая строка с ✗ говорит, ЧТО СДЕЛАТЬ, а не только что сломано.
// «нет THREADS_TOKEN» бесполезно, «нет THREADS_TOKEN: владелец аккаунта входит по ссылке
// из docs/03» ведёт к делу. Значения ключей доктор не печатает никогда.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./lib/config.mjs";
import { PROJECT_ROOT, dataDir, dataPath, env, envFile, has } from "./lib/env.mjs";
import { readJson } from "./lib/files.mjs";
import { request } from "./lib/http.mjs";
import { tg } from "./lib/telegram.mjs";
import { adapterNames } from "./channels/index.mjs";
import { REGISTRY, required } from "./tokens/registry.mjs";

const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);

const results = [];
const ok = (text) => results.push({ mark: "✓", text });
const warn = (text) => results.push({ mark: "⚠", text });
const bad = (text) => results.push({ mark: "✗", text });
const info = (text) => results.push({ mark: "·", text });
const head = (text) => results.push({ mark: "", text: `\n${text}` });

/** Ключи текстов бота, без которых он ответит именем ключа вместо фразы. */
const TEXT_KEYS = ["welcome", "unknown", "stopped", "btnLead", "leadAskNeed", "consentPd", "btnPdYes", "btnPdNo", "consentPdDeclined", "leadAlreadySaved", "leadSaved", "leadAskPhone", "btnContactShare", "btnLeadNoPhone", "phoneSaved", "questionRelayed", "consentAds", "btnAdsYes", "btnAdsNo", "consentAdsYes", "consentAdsNo", "consentVersion"];

/** Какие площадки считаем подключёнными: по наличию главного ключа. */
export function connectedChannels() {
  const main = { threads: "THREADS_TOKEN", telegram: "TG_CHANNEL", vk: "VK_GROUP_TOKEN", instagram: "IG_TOKEN", youtube: "YOUTUBE_REFRESH_TOKEN", rutube: "RUTUBE_TOKEN" };
  return Object.entries(main).filter(([, key]) => has(key)).map(([c]) => c);
}

function checkEnvironment(where) {
  head("Окружение");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}: нужен 20 или новее. Поставьте свежую версию с nodejs.org`);
  const file = envFile();
  if (file) ok(`файл окружения: ${file}`);
  else bad(`файл окружения не найден. ${where === "server" ? "На сервере это /opt/ecopolis-data/.env" : "На компьютере это .env.local в корне проекта"}: скопируйте .env.example и заполните`);
  info(`машина: ${where === "server" ? "сервер" : "компьютер оператора"}; подключённые площадки: ${connectedChannels().join(", ") || "пока ни одной"}`);
  for (const name of required(where, connectedChannels())) {
    const r = REGISTRY.find((x) => x.name === name);
    if (has(name)) continue;
    bad(`нет ${name}: ${r.what}`);
  }
  const missing = required(where, connectedChannels()).filter((n) => !has(n)).length;
  if (!missing && file) ok("обязательные переменные заданы");
  // Секрет, попавший не на ту машину, — лишний риск: при утечке менять придётся всё.
  for (const r of REGISTRY) if (r.secret && has(r.name) && !r.where.includes(where)) warn(`${r.name} задан, но на этой машине не нужен (${r.where.join(", ")}): уберите из файла окружения`);
  if (where === "operator" && has("TG_BOT_TOKEN")) warn("TG_BOT_TOKEN на компьютере: токен бота должен жить только в секретах релея");
}

function checkProject() {
  head("Проект");
  let cfg;
  try { cfg = config(); ok(`реестр zavod.config.json: площадок ${Object.keys(cfg.channels).length}, сессий ${cfg.sessions.length}`); }
  catch (e) { bad(`реестр не читается: ${e.message}`); return; }
  for (const [name, c] of Object.entries(cfg.channels)) {
    if (!adapterNames().includes(name)) bad(`площадка ${name} есть в реестре, но адаптера для неё нет`);
    else if (!existsSync(path.join(PROJECT_ROOT, c.adapter))) bad(`нет файла адаптера ${c.adapter}`);
    for (const t of c.slots || []) if (!/^\d{2}:\d{2}$/.test(t)) bad(`площадка ${name}: слот «${t}» не в виде ЧЧ:ММ`);
  }
  for (const s of cfg.sessions) if (!existsSync(path.join(PROJECT_ROOT, s.prompt))) bad(`нет промпта сессии ${s.id}: ${s.prompt}`);
  try {
    mkdirSync(dataDir(), { recursive: true });
    const probe = dataPath(`.doctor-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe);
    ok(`каталог данных доступен на запись: ${dataDir()}`);
  } catch (e) {
    bad(`каталог данных ${dataDir()} недоступен на запись: ${e.message}. Создайте его и отдайте пользователю, под которым работает завод`);
  }
  if (dataDir().startsWith(PROJECT_ROOT) && process.platform !== "win32") warn("каталог данных лежит внутри каталога кода: выкладка может его затереть. Задайте DATA_DIR=/opt/ecopolis-data");
  if (existsSync(dataPath("STOP"))) warn("выпуск остановлен файлом STOP");
  if (existsSync(dataPath("HOLD"))) warn("выпуск ждёт кнопки после простоя (файл HOLD)");
  if (existsSync(dataPath("TAKEOVER.json"))) warn("расписание сейчас ведёт этот компьютер (перехват). Вернуть серверу: npm run mirror -- --handback");
}

function checkBot() {
  head("Бот");
  const botDir = path.join(PROJECT_ROOT, "bot");
  const texts = readJson(path.join(botDir, "texts.json"));
  if (!texts) bad("нет bot/texts.json: бот ответит именами ключей вместо фраз");
  else {
    const lost = TEXT_KEYS.filter((k) => !texts[k]);
    if (lost.length) bad(`в bot/texts.json нет текстов: ${lost.join(", ")}`);
    else ok(`тексты бота: ${Object.keys(texts).length}, версия согласия ${texts.consentVersion}`);
    const client = config().client;
    if (texts.consentPd && !String(texts.consentPd).includes(client.inn)) warn(`в тексте согласия (consentPd) нет ИНН оператора ${client.inn}: согласие должно называть, кому оно даётся`);
  }
  const materials = readJson(path.join(botDir, "materials.json"), []) || [];
  const keys = new Set(materials.map((m) => String(m.key)));
  if (!materials.length) bad("нет bot/materials.json: по ссылкам с метками бот покажет только меню");
  else ok(`материалов бота: ${materials.length}`);
  for (const m of materials) if (!m.title || !m.teaser) bad(`материал ${m.key}: нужен заголовок и вводка`);
  const dir = path.join(botDir, "scenarios");
  const scenarios = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => { const d = readJson(path.join(dir, f)); if (!d) { bad(`сценарий ${f} не читается как JSON`); return []; } return Array.isArray(d) ? d : [d]; }) : [];
  if (!scenarios.length) bad("нет сценариев кодовых слов в bot/scenarios");
  const seen = new Map();
  for (const s of scenarios) {
    const key = s["ключ"];
    if (!key || !(s["слова"] || []).length) { bad(`сценарий без ключа или слов: ${JSON.stringify(s).slice(0, 60)}`); continue; }
    if (s["включён"] === false) { info(`сценарий ${key} выключен: бот на него не отвечает`); continue; }
    if (!String(s["текст"] || "").includes("{ссылка}")) bad(`сценарий ${key}: в тексте нет {ссылка}, человек не получит ссылку на материал`);
    if (!keys.has(String(key))) bad(`сценарий ${key}: в bot/materials.json нет материала с таким ключом, бот покажет меню вместо материала`);
    if (!s["максДлина"]) warn(`сценарий ${key}: не задан «максДлина». Без предела слово сработает внутри чужого разговора`);
    if (/https?:\/\//.test(String(s["публично"] || ""))) bad(`сценарий ${key}: ссылка в публичном ответе. В комментариях Instagram ссылки не нажимаются`);
    for (const w of s["слова"]) {
      const n = String(w).toLowerCase().replace(/ё/g, "е");
      // «ПРИЁМКА» и «ПРИЕМКА» в одном сценарии — одно и то же слово, это не ошибка.
      if (seen.has(n) && seen.get(n) !== key) bad(`слово «${w}» есть в двух сценариях: ${seen.get(n)} и ${key}`);
      seen.set(n, key);
    }
  }
  if (scenarios.length) ok(`кодовых слов: ${seen.size} в ${scenarios.length} сценариях`);
  const approved = readJson(path.join(PROJECT_ROOT, "legal", "site", "approved.json"), {}) || {};
  for (const doc of ["soglasie", "politika", "soglasie-na-rassylku"]) {
    const file = path.join(PROJECT_ROOT, "legal", "site", `${doc}.md`);
    if (!existsSync(file)) { bad(`нет legal/site/${doc}.md: ссылка из формы и бота ведёт в пустоту`); continue; }
    const hole = readFileSync(file, "utf8").match(/\[[^\]\n]{3,80}\](?!\()/);
    if (hole) bad(`legal/site/${doc}.md: не заполнено «${hole[0]}». Документ с пустым местом людям показывать нельзя`);
    if (!approved[doc]?.date) warn(`legal/site/${doc}.md не утверждён юристом клиента (legal/site/approved.json). До утверждения бот и формы заявок не включаются`);
    else if (texts && approved[doc].version !== texts.consentVersion && doc !== "politika") warn(`версия документа ${doc} (${approved[doc].version}) не совпадает с версией согласия в боте (${texts.consentVersion})`);
  }
}

async function checkLive(where) {
  head("Связь");
  const me = await tg("getMe");
  if (me.kind === "ok") ok(`бот @${me.result?.username} отвечает ${env("TG_RELAY_URL") ? "через релей" : "напрямую"}`);
  else bad(`бот не отвечает (${me.kind === "network" ? "сеть" : "отказ"}): ${me.error}. Проверьте TG_RELAY_URL и TG_RELAY_SECRET; с сервера в России напрямую Telegram не открывается`);
  if (me.kind === "ok" && has("TG_BOT_USERNAME") && me.result?.username?.toLowerCase() !== env("TG_BOT_USERNAME").toLowerCase()) bad(`TG_BOT_USERNAME=${env("TG_BOT_USERNAME")}, а отвечает @${me.result.username}: ссылки с метками ведут не в того бота`);
  if (has("TG_GROUP_ID") && me.kind === "ok") {
    const chat = await tg("getChat", { chat_id: env("TG_GROUP_ID") });
    if (chat.kind !== "ok") bad(`рабочая группа недоступна: ${chat.error}. Добавьте бота в группу и проверьте TG_GROUP_ID`);
    else {
      ok(`рабочая группа «${chat.result?.title}»${chat.result?.is_forum ? ", с темами" : ", без тем"}`);
      const member = await tg("getChatMember", { chat_id: env("TG_GROUP_ID"), user_id: me.result.id });
      if (member.result?.status !== "administrator") warn("бот в рабочей группе не администратор: он не увидит ответы на карточки. Сделайте его администратором");
      if (chat.result?.is_forum && !has("TG_TOPIC_APPROVAL")) warn("в группе включены темы, а номера тем не заданы (TG_TOPIC_*): всё пойдёт в общую тему");
    }
  }
  if (where === "server" && has("APPROVER_IDS") === false) bad("нет APPROVER_IDS: согласовать публикацию некому");

  const { live } = await import("./tokens/check.mjs");
  for (const r of (await live()).filter((x) => x.channel !== "telegram-бот")) {
    if (r.kind === "ok") ok(`${r.channel}: ${r.detail}`);
    else if (r.kind === "skip") info(`${r.channel}: ${r.detail}`);
    else if (r.kind === "network") warn(`${r.channel}: не дозвонились (${r.detail}). Ключ при этом может быть жив`);
    else bad(`${r.channel}: площадка отвергла ключ: ${r.detail}`);
  }

  const base = env("QUEUE_API_BASE") || (where === "operator" ? env("PUBLIC_BASE_URL") : "");
  if (base) {
    const h = await request(`${base.replace(/\/+$/, "")}/health`, { timeoutMs: 15_000 });
    if (h.kind !== "ok") bad(`сервер завода не отвечает по адресу ${base}: ${h.error}`);
    else {
      const age = h.data.runnerAt ? Math.round((Date.now() - Date.parse(h.data.runnerAt)) / 60_000) : null;
      if (age === null) warn("сервер отвечает, но выпуск ещё ни разу не запускался: проверьте cron");
      else if (age > 20) bad(`сервер отвечает, выпуск не ходил ${age} мин: проверьте cron на сервере`);
      else ok(`сервер отвечает, выпуск ходил ${age} мин назад${h.data.stopped ? ", ОСТАНОВЛЕН" : ""}`);
      const q = await request(`${base.replace(/\/+$/, "")}/admin/queue`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env("ADMIN_API_TOKEN")}` }, body: JSON.stringify({ cmd: "slots", args: { count: 1 } }), timeoutMs: 20_000 });
      if (q.kind === "ok" && q.data?.code === 0) ok("ключ оператора к очереди подходит");
      else bad(`очередь на сервере не пустила: ${q.error || (q.data?.lines || []).join("; ")}. Сверьте ADMIN_API_TOKEN: npm run tokens -- --compare`);
    }
  }
}

async function checkMedia() {
  head("Хранилище файлов");
  if (!has("S3_ENDPOINT") || !has("S3_BUCKET")) { bad("хранилище не настроено (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY): без него не выйдут рилсы и картинки в Threads"); return; }
  const { uploadFile } = await import("./media/upload.mjs");
  // Маленькая настоящая картинка: 1×1 PNG.
  const file = path.join(os.tmpdir(), `zavod-doctor-${process.pid}.png`);
  writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  try {
    const res = await uploadFile(file, { key: "doctor/probe.png" });
    if (res.ok) ok(`хранилище принимает файлы и отдаёт их наружу: ${res.url}`);
    else bad(`хранилище: ${res.error}`);
    if (res.ok) info("доходит ли до этого адреса Meta, покажет только первый рилс: это шаг сессии S2");
  } catch (e) {
    bad(`хранилище: ${e.message}`);
  } finally {
    rmSync(file, { force: true });
  }
}

async function main() {
  const where = opt("where") || (process.platform === "win32" || process.platform === "darwin" || has("QUEUE_API_BASE") ? "operator" : "server");
  checkEnvironment(where);
  checkProject();
  checkBot();
  if (flag("live")) await checkLive(where);
  if (flag("media")) await checkMedia();
  for (const r of results) console.log(r.mark ? `${r.mark} ${r.text}` : r.text);
  const fails = results.filter((r) => r.mark === "✗").length;
  const warns = results.filter((r) => r.mark === "⚠").length;
  console.log(`\n${fails ? `чинить: ${fails}` : "чинить нечего"}${warns ? `, посмотреть: ${warns}` : ""}${flag("live") ? "" : " · живые вызовы не делались (добавьте --live)"}`);
  return fails ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`доктор не отработал: ${e?.stack || e}`); process.exitCode = 2; });
}
