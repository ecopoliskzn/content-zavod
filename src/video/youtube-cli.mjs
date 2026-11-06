#!/usr/bin/env node
// YouTube с компьютера оператора: вход владельца канала, загрузка, серии, описания, опись канала.
// YouTube — основная видео-площадка завода, поэтому здесь всё, чем канал ведётся.
//
//   npm run yt -- --login                               один раз: согласие в браузере, ключ ляжет в .env.local
//   npm run yt -- --channel [--analytics]               опись канала: все ролики, отрыв от медианы, досмотр
//   npm run yt -- --desc --id=<запись>                  показать описание, которое уйдёт на канал
//   npm run yt -- --upload --id=<запись> --file=<путь> [--thumb=<обложка>]
//   npm run yt -- --status --video=<номер ролика>
//   npm run yt -- --update --id=<запись>                отправить на ролик название и описание записи, изменённые после загрузки
//   npm run yt -- --relink [--series=<ключ>]            обновить ссылки на соседние ролики в описаниях серии
//   npm run yt -- --restore --video=<номер>             вернуть описание, каким оно было до первой правки завода
//   npm run yt -- --series                              серии и что в них
//   npm run yt -- --series-create --series=<ключ>       создать плейлист серии на канале
//   npm run yt -- --series-add --series=<ключ> --video=<номер>   включить в серию старый ролик канала
//   npm run yt -- --series-sort --series=<ключ>         порядок по просмотрам, плейлист приводится к нему
//   npm run yt -- --thumb --video=<номер> --file=<обложка>
//
// ЗАГРУЗКА ПРИВЯЗАНА К ЗАПИСИ ОЧЕРЕДИ. Название, текст описания и слот берутся из записи,
// которую одобрил человек клиента: ролик уходит закрытым с датой выхода из слота, и
// YouTube открывает его сам. Номер ролика записывается обратно в запись, и сервер в слот
// сверяет, что ролик открылся. Загрузить «просто файл» в обход очереди скрипт не даёт.
//
// СРОК ВЫХОДА СЛЕДУЕТ ЗА ЗАПИСЬЮ. Дату выхода на YouTube после загрузки ведёт сервер:
// запись сняли, отозвали согласие, отправили на правку или остановили выпуск — срок с
// ролика снимается; переставили слот — срок переезжает; одобрили ролик, загруженный до
// «да», — срок ставится. Руками в Студии дату не трогают. Подробно: src/video/schedule.mjs.
//
// ОПИСАНИЕ СОБИРАЕТСЯ ИЗ ДВУХ ЧАСТЕЙ. Текст согласует человек. Блок ссылок под ним
// (серия, соседние части, статья, «смотрите также») ставит программа из реестра серий
// content/youtube/series.json. Вышла новая часть — команда --relink дописывает ссылку на
// неё прошлым частям; согласованный текст при этом не меняется.
//
// ВХОД. Владелец канала входит СВОИМ аккаунтом Google на этом компьютере. Права берутся
// сразу все: загрузка, управление (описания, плейлисты, обложки) и аналитика. Задним
// числом право к ключу не добавить: у нас ключ «только на загрузку» потом не смог собрать
// плейлисты. Значение ключа скрипт не печатает никогда.

import { createServer } from "node:http";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, env } from "../lib/env.mjs";
import { setEnv } from "../lib/envfile.mjs";
import { readJson, writeJson } from "../lib/files.mjs";
import { request, sleep } from "../lib/http.mjs";
import { dueAt } from "../lib/time.mjs";
import {effectiveDue} from '../queue/timing.mjs';
import { probe, setSchedule, status, upload } from "../channels/youtube.mjs";
import { video as videoGate } from "../gates/rules.mjs";
import { describeContext } from "./describe.mjs";
import { composeDescription, pinnedComment, relations, sortByViews, swapRelations, withVideo } from "./series.mjs";
import { addToPlaylist, channelSnapshot, createPlaylist, orderPlaylist, setThumbnail, updateSnippet, videos } from "./youtube-tools.mjs";

const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);

const DIR = path.join(PROJECT_ROOT, "content", "youtube");
const SERIES = path.join(DIR, "series.json");
const CHANNEL = path.join(DIR, "channel.json");
const loadRegistry = () => readJson(SERIES, { series: [] }) || { series: [] };
const saveRegistry = (r) => { mkdirSync(DIR, { recursive: true }); writeJson(SERIES, r); };

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

/** Всё, что нужно сборке описания: реестр серий, адреса, названия роликов. */
function context(registry, videoId = "") {
  const snapshot = readJson(CHANNEL, { list: [] }) || { list: [] };
  const titles = Object.fromEntries((snapshot.list || []).map((v) => [v.id, v.title]));
  for (const s of registry.series || []) for (const v of s.videos || []) if (v.id && v.title) titles[v.id] = v.title;
  return describeContext({ registry, videoId, platform: "youtube", titles });
}

async function entryOf(ref) {
  const shown = await queue("show", { ref, channel: "youtube" });
  if (!shown.data) throw Object.assign(new Error((shown.lines || []).join("\n") || `записи «${ref}» нет в очереди`), { code: shown.code === 2 ? "ENV" : "RULE" });
  return shown.data;
}

async function login() {
  const id = env("YOUTUBE_CLIENT_ID");
  const secret = env("YOUTUBE_CLIENT_SECRET");
  if (!id || !secret) { console.error("нет YOUTUBE_CLIENT_ID или YOUTUBE_CLIENT_SECRET в .env.local: их выдаёт Google Cloud, раздел «Учётные данные»"); return 2; }
  const port = 53682;
  const redirect = `http://127.0.0.1:${port}/`;
  const scope = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/yt-analytics.readonly"].join(" ");
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: "code", scope, access_type: "offline", prompt: "consent" })}`;
  // Браузер сами не открываем: системный «открыть» ведёт в браузер по умолчанию, а аккаунт
  // канала может жить в другом. У нас так дважды входили не тем аккаунтом.
  console.log("Откройте адрес в том браузере, где выполнен вход аккаунтом ВЛАДЕЛЬЦА КАНАЛА, и нажмите «Разрешить»:\n");
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
  console.log("Перенесите переменные YouTube на сервер тем же способом, каким туда кладутся остальные ключи.");
  return 0;
}

/* Память о правках описаний: каким описание было до первой правки завода (first) и какой
   блок ссылок мы дописали в прошлый раз (block). Лежит в git рядом с реестром серий:
   описание чужого ролика правится только с возможностью вернуть всё как было. */
const HISTORY = path.join(DIR, "history");
const historyFile = (videoId) => path.join(HISTORY, `${videoId}.json`);
const loadHistory = (videoId) => readJson(historyFile(videoId), null);
function saveHistory(videoId, state) {
  mkdirSync(HISTORY, { recursive: true });
  writeJson(historyFile(videoId), { ...state, at: new Date().toISOString() });
}

/** Обновить блоки ссылок у роликов серии. Возвращает число изменённых описаний. */
async function relink(registry, only = "") {
  let changed = 0;
  let failed = 0;
  let skipped = 0;
  for (const s of registry.series || []) {
    if (only && s.key !== only) continue;
    for (const v of (s.videos || []).filter((x) => x.id)) {
      const ctx = context(registry, v.id);
      const cur = await videos([v.id], "snippet");
      const live = cur.items?.[0]?.snippet?.description;
      if (live === undefined) { console.log(`  ✗ ${v.id}: ролик не читается`); failed++; continue; }
      const state = loadHistory(v.id);
      let description;
      let next = { first: state?.first ?? live, block: state?.block || "" };
      if (v.name) {
        // Ролик вышел через завод: описание собирается заново из согласованного текста.
        const shown = await queue("show", { ref: v.name, channel: "youtube" });
        if (!shown.data) console.log(`  · ${v.id}: записи «${v.name}» в очереди уже нет, меняю только блок ссылок`);
        else description = composeDescription(shown.data, ctx);
      }
      if (description === undefined) {
        // Старый ролик канала: текст клиента не трогаем, меняем только то, что дописали сами.
        const swap = swapRelations(live, relations({ name: "", series: s.key }, ctx), state);
        if (swap.skipped) { console.log(`  · ${v.id}: ${swap.skipped}`); skipped++; continue; }
        description = swap.description;
        next = swap.state;
      }
      if (description.length > 5000) { console.log(`  ✗ ${v.id}: описание ${description.length} знаков, предел 5000`); failed++; continue; }
      if (description === String(live).replace(/\r\n?/g, "\n").replace(/\s+$/, "")) continue;
      // Память пишется ДО правки: если процесс оборвётся после неё, прежнее описание уже сохранено.
      saveHistory(v.id, next);
      const r = await updateSnippet(v.id, { description });
      if (!r.ok) { console.log(`  ✗ ${v.id}: ${r.error}`); failed++; }
      else if (r.changed) { console.log(`  ✓ ${r.title}`); changed++; }
    }
  }
  return { changed, failed, skipped };
}

/*
 * КВИТАНЦИЯ ЗАГРУЗКИ. Ролик загружен, а номер ролика ещё нужно записать в запись очереди
 * на сервере. Если этот запрос оборвётся, запись о ролике не узнает: повтор команды
 * загрузил бы второй ролик, а первый открылся бы сам по своему сроку, и ни «Снять», ни
 * /stop_release на него бы не действовали. Поэтому номер ролика сначала пишется на диск
 * этого компьютера, и только потом уходит на сервер. Повтор команды видит квитанцию и
 * дозаписывает номер, а не грузит ролик заново.
 */
const RECEIPTS = () => path.resolve(env("MIRROR_DIR", path.join(PROJECT_ROOT, "mirror")), "uploads");
const receiptFile = (entryId) => path.join(RECEIPTS(), `${entryId}.json`);
const loadReceipt = (entryId) => readJson(receiptFile(entryId), null);
const saveReceipt = (entryId, data) => { mkdirSync(RECEIPTS(), { recursive: true }); writeJson(receiptFile(entryId), data); };
const dropReceipt = (entryId) => { try { unlinkSync(receiptFile(entryId)); } catch { /* уже убрана */ } };
const STUDIO = "Студия YouTube → «Контент» → ролик → «Параметры доступа» → «Ограниченный доступ», без даты";

/**
 * Записать номер загруженного ролика в запись очереди. Три попытки; не вышло — срок
 * выхода с ролика снимается тем же ключом: ролик без хозяина не должен открыться сам.
 * @returns {Promise<{ code: number, lines?: string[], data?: object }>}
 */
async function register(entry, receipt) {
  const link = `https://www.youtube.com/watch?v=${receipt.videoId}`;
  let saved = { code: 2, lines: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(2_000 * attempt);
    saved = await queue("extra", { ref: entry.id, fields: { youtubeId: receipt.videoId, youtubePublishAt: receipt.publishAt || "", youtubeHash: receipt.contentHash } });
    if (saved.code === 0 || saved.code === 1) break; // записано либо отказ по правилу: повтор не поможет
  }
  if (saved.code === 0) {
    dropReceipt(entry.id);
    console.log((saved.lines || []).join("\n"));
    return saved;
  }
  console.error(`✗ номер ролика не записался в очередь: ${(saved.lines || []).join("; ") || "сервер не ответил"}`);
  if (receipt.publishAt) {
    const live = await status(receipt.videoId);
    const off = live.kind === "ok" ? await setSchedule(live.raw, "") : { ok: false, error: live.error };
    if (off.ok) {
      saveReceipt(entry.id, { ...receipt, publishAt: "" });
      console.error("срок выхода с ролика снят: пока запись о нём не знает, сам он не откроется");
    } else {
      console.error(`✗ срок выхода с ролика снять не удалось (${off.error}). YouTube откроет его сам ${receipt.publishAt}. Снимите дату руками: ${STUDIO}`);
    }
  }
  console.error(`ролик лежит на YouTube закрытым: ${link}. Повторите эту же команду, когда сервер ответит: второй раз ролик не загрузится, дозапишется только номер, а срок выхода сервер поставит сам`);
  return saved;
}

async function doUpload() {
  const ref = opt("id");
  const file = opt("file");
  if (!ref || !file) { console.error("нужны --id=<номер или имя записи очереди> и --file=<путь к ролику>"); return 1; }
  if (!existsSync(file)) { console.error(`нет файла: ${file}`); return 2; }
  const entry = await entryOf(ref);
  if (!["approved", "review"].includes(entry.status)) { console.error(`запись в статусе «${entry.status}»: загружается одобренное (или ждущее «да», тогда ролик останется закрытым до согласования)`); return 1; }
  if (entry.extra?.youtubeId) { console.error(`ролик уже загружен: https://www.youtube.com/watch?v=${entry.extra.youtubeId}`); dropReceipt(entry.id); return 1; }
  let registry = loadRegistry();
  if (entry.series && !(registry.series || []).some((s) => s.key === entry.series)) { console.error(`в записи стоит серия «${entry.series}», а в content/youtube/series.json её нет: заведите серию или уберите поле`); return 1; }

  let receipt = loadReceipt(entry.id);
  if (receipt?.videoId) {
    // Прошлый запуск загрузил ролик, а номер до сервера не дошёл: второй раз не грузим.
    console.log(`ролик уже загружен прошлым запуском: https://www.youtube.com/watch?v=${receipt.videoId}. Тогда номер не записался в очередь: дозаписываю`);
  } else {
    const description = composeDescription(entry, context(registry));
    if (description.length > 5000) { console.error(`описание с блоком ссылок ${description.length} знаков, предел YouTube 5000: сократите текст`); return 1; }
    const due = effectiveDue(entry);
    /* Дата выхода ставится только одобренной записи: неодобренный ролик сам не откроется.
       И только с запасом в полчаса. Загрузка идёт минуты, и всё это время запись на сервере
       ещё не знает номера ролика: если её снимут посреди загрузки, срок, решённый в начале,
       простоит до первой сверки. С запасом сверка успевает; без него ролик загружается без
       срока, и в слот его открывает сервер. */
    const publishAt = entry.status === "approved" && due > Date.now() + 30 * 60_000 ? new Date(due).toISOString() : undefined;
    console.log(`загружаю «${entry.title}»${publishAt ? `, выход ${entry.date} в ${entry.time} МСК` : entry.status === "approved" ? ", без даты выхода: до слота меньше получаса, ролик откроет сервер" : ", без даты выхода: запись ещё ждёт «да». Срок сервер поставит сам, когда её одобрят"}…`);
    const res = await upload({ file, title: entry.title, description, tags: entry.tags || [], publishAt, privacy: "private" });
    if (!res.ok) { console.error(`✗ ${res.error}`); return 1; }
    console.log(`✓ загружено: https://www.youtube.com/watch?v=${res.id} · доступ: ${res.privacy}`);
    if (res.warning) console.error(`⚠ ${res.warning}`);
    // Квитанция пишется ДО запроса к серверу. В ней и отпечаток отправленного текста.
    receipt = { videoId: res.id, publishAt: publishAt || "", contentHash: entry.contentHash, name: entry.name, at: new Date().toISOString() };
    saveReceipt(entry.id, receipt);
  }
  /* Вместе с номером ролика записывается отпечаток отправленного содержимого: по нему сервер
     видит, что на ролике лежит именно одобренный текст. Сервер тут же сверяет срок с
     записью: если её сняли, пока шла загрузка, срок снимается сразу, и строка скажет об этом. */
  const saved = await register(entry, receipt);
  if (saved.code !== 0) return saved.code || 2;
  const videoId = receipt.videoId;
  const publishAt = saved.data?.extra?.youtubePublishAt || receipt.publishAt || "";
  if (saved.data && saved.data.status !== entry.status) console.error(`⚠ пока шла загрузка, запись изменилась: была «${entry.status}», стала «${saved.data.status}». Ролик лежит закрытым; что с ним делать, решите с утверждающим`);
  if (opt("thumb")) {
    const t = await setThumbnail(videoId, opt("thumb"));
    console.log(t.ok ? "✓ обложка поставлена" : `⚠ ${t.error}`);
  }
  if (entry.series) {
    // Срок выхода пишется в реестр: до него соседние ролики на этот не ссылаются, иначе
    // зритель по ссылке «следующая часть» попадёт на «видео недоступно».
    registry = withVideo(registry, entry.series, { id: videoId, name: entry.name, title: entry.title, ...(publishAt ? { publishAt } : {}) });
    saveRegistry(registry);
    const s = registry.series.find((x) => x.key === entry.series);
    if (s.playlistId) {
      const a = await addToPlaylist(s.playlistId, videoId);
      console.log(a.ok ? `✓ ролик добавлен в плейлист «${s.title}»` : `⚠ в плейлист не добавился: ${a.error}`);
    } else {
      console.log(`· у серии «${s.title}» ещё нет плейлиста: npm run yt -- --series-create --series=${s.key}`);
    }
    // Новому ролику ссылки на вышедшие части ставятся сразу. Прошлым частям ссылка на него
    // дописывается после выхода: до тех пор он закрыт.
    const r = await relink(registry, entry.series);
    console.log(`ссылки в серии обновлены: описаний изменено ${r.changed}${r.failed ? `, не удалось ${r.failed}` : ""}`);
    if (publishAt) console.log(`после выхода ролика (${entry.date} в ${entry.time} МСК) дайте остальным роликам серии ссылку на него: npm run yt -- --relink --series=${s.key}`);
  }
  console.log("\nЗакреплённый комментарий (после выхода ролика его ставит и закрепляет человек в Студии; текст придёт в рабочую группу):\n");
  console.log(pinnedComment(entry, context(registry, videoId)));
  return 0;
}

async function main() {
  if (flag("login")) return login();
  if (flag("upload")) return doUpload();

  if (flag("status")) {
    const s = await status(opt("video"));
    console.log(s.kind === "ok" ? `«${s.title}» · доступ ${s.privacy}${s.publishAt ? ` · выход ${s.publishAt}` : ""} · обработка ${s.upload}` : `✗ ${s.error}`);
    return s.kind === "ok" ? 0 : s.kind === "network" ? 2 : 1;
  }

  if (flag("desc")) {
    const entry = await entryOf(opt("id"));
    const registry = loadRegistry();
    const text = composeDescription(entry, context(registry, entry.extra?.youtubeId || ""));
    console.log(`${entry.title}\n${"─".repeat(60)}\n${text}\n${"─".repeat(60)}`);
    // Проверяется согласованный текст записи, а не собранное описание: хэштеги и ссылки
    // под текстом ставит программа, и замечание «хэштеги в тексте» на них было бы ложным.
    const verdict = videoGate(entry);
    for (const b of verdict.block) console.log(`⛔ ${b}`);
    for (const w of verdict.warn) console.log(`⚠ ${w}`);
    console.log(`знаков: ${text.length} из 5000`);
    return verdict.block.length ? 1 : 0;
  }

  if (flag("update")) {
    const entry = await entryOf(opt("id"));
    const id = entry.extra?.youtubeId;
    if (!id) { console.error("у записи нет номера ролика: она ещё не загружена"); return 1; }
    /* Текст, которому человек клиента ещё не сказал «да», на открытый ролик не уходит.
       На закрытый можно: его никто не видит, а срок выхода появится только после «Одобрить». */
    const live = await status(id);
    if (live.kind === "ok" && live.privacy === "public" && !["approved", "published"].includes(entry.status)) { console.error(`ролик уже открыт на YouTube, а запись «${entry.status}»: неодобренный текст на открытый ролик не отправляется. Сначала согласование`); return 1; }
    const registry = loadRegistry();
    const r = await updateSnippet(id, { title: entry.title, description: composeDescription(entry, context(registry, id)), tags: entry.tags || [] });
    console.log(r.ok ? (r.changed ? `✓ обновлено: ${r.title}` : "без изменений: на канале уже так") : `✗ ${r.error}`);
    if (!r.ok) return 1;
    /* Отпечаток того, что теперь лежит на ролике. Пока он не равен отпечатку одобренной
       записи, сервер не ставит ролику срок и не открывает его: после правки на YouTube
       оставались бы прежние, отклонённые название и описание. */
    const saved = await queue("extra", { ref: entry.id, fields: { youtubeHash: entry.contentHash } });
    console.log((saved.lines || []).join("\n"));
    if (entry.status !== "approved") console.log(`запись сейчас «${entry.status}»: срок выхода появится после «Одобрить»`);
    return saved.code || 0;
  }

  if (flag("relink")) {
    const r = await relink(loadRegistry(), opt("series"));
    console.log(`описаний изменено: ${r.changed}${r.skipped ? `, пропущено (правили руками): ${r.skipped}` : ""}${r.failed ? `, не удалось: ${r.failed}` : ""}`);
    if (r.changed) console.log(`прежние описания сохранены: ${path.relative(PROJECT_ROOT, HISTORY)}. Вернуть: npm run yt -- --restore --video=<номер ролика>`);
    return r.failed ? 1 : 0;
  }

  if (flag("restore")) {
    // Вернуть описание, каким оно было до первой правки завода.
    const id = opt("video");
    const state = id ? loadHistory(id) : null;
    if (!state) { console.error(id ? `про ролик ${id} ничего не запомнено: завод его описание не правил` : "нужен --video=<номер ролика>"); return 1; }
    const r = await updateSnippet(id, { description: state.first });
    if (!r.ok) { console.error(`✗ ${r.error}`); return 1; }
    saveHistory(id, { first: state.first, block: "" });
    console.log(r.changed ? `✓ описание возвращено: ${r.title}` : "без изменений: на канале уже так");
    return 0;
  }

  if (flag("series")) {
    const registry = loadRegistry();
    if (!(registry.series || []).length) console.log("серий нет: заведите их в content/youtube/series.json (образец: prompts/samples/серии-youtube.md)");
    for (const s of registry.series || []) {
      console.log(`${s.key} · «${s.title}» · ${s.order === "parts" ? "по частям" : "по просмотрам"} · ${s.playlistId ? `https://www.youtube.com/playlist?list=${s.playlistId}` : "плейлиста ещё нет"}`);
      for (const v of s.videos || []) console.log(`   ${v.id || "ещё не вышел".padEnd(11)}  ${v.title || v.name || ""}`);
    }
    return 0;
  }

  if (flag("series-create")) {
    const registry = loadRegistry();
    const s = (registry.series || []).find((x) => x.key === opt("series"));
    if (!s) { console.error(`серии «${opt("series")}» нет в content/youtube/series.json`); return 1; }
    if (s.playlistId) { console.error(`плейлист уже есть: https://www.youtube.com/playlist?list=${s.playlistId}`); return 1; }
    const made = await createPlaylist({ title: s.title, description: s.description || "" });
    if (!made.ok) { console.error(`✗ плейлист не создан: ${made.error}`); return 1; }
    s.playlistId = made.id;
    saveRegistry(registry);
    const ids = (s.videos || []).map((v) => v.id).filter(Boolean);
    const ordered = ids.length ? await orderPlaylist(made.id, ids) : { ok: true, added: 0 };
    console.log(`✓ https://www.youtube.com/playlist?list=${made.id} · роликов добавлено ${ordered.added ?? 0}${ordered.ok ? "" : ` · ${ordered.error}`}`);
    const r = await relink(registry, s.key);
    console.log(`ссылки на плейлист проставлены: описаний изменено ${r.changed}`);
    return ordered.ok ? 0 : 1;
  }

  if (flag("series-add")) {
    const id = opt("video");
    if (!id) { console.error("нужен --video=<номер ролика>"); return 1; }
    const found = await videos([id], "snippet");
    const title = opt("title") || found.items?.[0]?.snippet?.title;
    if (!title) { console.error(`ролик ${id} не найден на YouTube`); return 1; }
    let registry;
    try { registry = withVideo(loadRegistry(), opt("series"), { id, title }); } catch (e) { console.error(e.message); return 1; }
    saveRegistry(registry);
    const s = registry.series.find((x) => x.key === opt("series"));
    if (s.playlistId) { const a = await addToPlaylist(s.playlistId, id); console.log(a.ok ? "✓ добавлен в плейлист" : `⚠ ${a.error}`); }
    console.log(`✓ «${title}» в серии «${s.title}». Проставить ссылки: npm run yt -- --relink --series=${s.key}`);
    return 0;
  }

  if (flag("series-sort")) {
    const registry = loadRegistry();
    const s = (registry.series || []).find((x) => x.key === opt("series"));
    if (!s) { console.error(`серии «${opt("series")}» нет`); return 1; }
    if (s.order === "parts") { console.error("это серия по частям: её порядок задаёт сюжет, а не просмотры"); return 1; }
    const snapshot = readJson(CHANNEL);
    if (!snapshot) { console.error("нет описи канала: сначала npm run yt -- --channel"); return 1; }
    const views = new Map(snapshot.list.map((v) => [v.id, v.views]));
    s.videos = sortByViews(s.videos || [], views);
    saveRegistry(registry);
    for (const v of s.videos) console.log(`  ${String(views.get(v.id) ?? "—").padStart(8)}  ${v.title || v.id}`);
    if (s.playlistId) {
      const r = await orderPlaylist(s.playlistId, s.videos.map((v) => v.id).filter(Boolean));
      console.log(r.ok ? `✓ плейлист приведён к этому порядку: добавлено ${r.added}, переставлено ${r.moved}` : `✗ ${r.error}`);
      return r.ok ? 0 : 1;
    }
    return 0;
  }

  if (flag("thumb")) {
    const r = await setThumbnail(opt("video"), opt("file"));
    console.log(r.ok ? "✓ обложка поставлена" : `✗ ${r.error}`);
    return r.ok ? 0 : 1;
  }

  if (flag("channel")) {
    const r = await channelSnapshot({ withAnalytics: flag("analytics") });
    if (r.kind !== "ok") { console.error(`✗ опись не снята: ${r.error}`); return r.kind === "network" ? 2 : 1; }
    mkdirSync(DIR, { recursive: true });
    writeJson(CHANNEL, r.snapshot);
    const s = r.snapshot;
    console.log(`«${s.title}»: подписчиков ${s.subscribers}, роликов ${s.videos} (коротких ${s.shorts}), медиана просмотров ${s.medianViews}`);
    for (const v of s.list.slice(0, 12)) console.log(`${String(v.views).padStart(8)} · ${String(v.ratio).padStart(6)}× · ${v.short ? "короткий" : "обычный "} · ${v.date}${v.watchPct !== undefined ? ` · досмотр ${v.watchPct}%` : ""} · ${v.title.slice(0, 60)}`);
    if (s.analyticsUntil) {
      const held = s.list.filter((v) => v.watchPct !== undefined && v.views >= s.medianViews).sort((a, b) => b.watchPct - a.watchPct).slice(0, 5);
      console.log("\nлучше всего досматривают (из роликов не ниже медианы): на них вести «смотрите также»");
      for (const v of held) console.log(`   досмотр ${v.watchPct}% · подписок ${v.subs} · ${v.title.slice(0, 64)}`);
    } else {
      console.log("\nдосмотра в описи нет: добавьте --analytics (нужен вход владельца канала)");
    }
    console.log(`\nфайл: ${path.relative(PROJECT_ROOT, CHANNEL)}`);
    return 0;
  }

  console.error("что сделать: --login | --channel [--analytics] | --desc --id= | --upload --id= --file= | --status --video= | --update --id= | --relink | --restore --video= | --series | --series-create --series= | --series-add --series= --video= | --series-sort --series= | --thumb --video= --file=");
  return 1;
}

let code = 1;
try { code = await main(); } catch (e) { console.error(`✗ ${e.message}`); code = e.code === "RULE" ? 1 : 2; }
process.exitCode = code;
