#!/usr/bin/env node
// Сборщик витрины Obsidian: живое состояние завода → хранилище заметок со связями.
//
//   npm run vault                 собрать в каталог vault/ (или VAULT_DIR)
//   npm run vault -- --check      собрать в памяти и только посчитать: заметок, связей, висячих ссылок
//
// ЗАЧЕМ ВИТРИНА. Завод состоит из частей, которые не видно глазами: очередь, проверки,
// расписание, ключи, бот, релей. Граф Obsidian показывает их как есть: статья сайта →
// ветка, пост и ролик → площадки → переходы → заявки. Это и карта для команды, и то,
// что показывают клиенту вместо слов «у нас всё автоматизировано».
//
// ИЗ ЧЕГО СОБИРАЕТСЯ. Ничего не пишется руками:
//   zavod.config.json          площадки, слоты, сессии, расписания;
//   src/**                     модули, их шапки, связи между ними и ключи, которые они читают;
//   mirror/**                  снимок с сервера: очередь, журнал, цифры, новости, воронка;
//   content/, bot/, prompts/, docs/, legal/   материалы, сценарии бота, промпты, документы.
// Заметку нельзя «поправить в Obsidian»: следующая сборка её перезапишет. Правится источник.
//
// ПЕРСОНАЛЬНЫХ ДАННЫХ В ВИТРИНЕ НЕТ. Она строится из снимка, а в снимок сервер отдаёт
// только счёт. Витрину можно показывать на экране и отдавать клиенту.
//
// СВОИ ЗАМЕТКИ НЕ ТРОГАЮТСЯ. Сборщик помнит, какие файлы создал сам (список в
// .zavod-manifest.json), и удаляет только их. Заметка, написанная человеком, остаётся.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT, env } from "../lib/env.mjs";
import { readJson } from "../lib/files.mjs";
import { addDays, dueAt, mskDate, mskTime } from "../lib/time.mjs";
import { checkAll } from "../gates/rules.mjs";
import { STATUSES, STATUS_TITLE, canMove, preview } from "../queue/format.mjs";
import { median } from "../metrics/summary.mjs";
import { REGISTRY } from "../tokens/registry.mjs";
import { bar, callout, canvas, cellLink, column, danglingLinks, frontmatter, link, linksIn, num, safe, table, tag } from "./lib.mjs";

const AUTO = "Заметка собрана автоматически. Править нужно источник, а не её: следующая сборка перезапишет.";

/** Части завода: узлы карты. К каждому привязаны модули по началу пути. */
const NODES = [
  { key: "server", title: "Сервер завода", color: "4", modules: ["src/server.mjs"], what: "Виртуальный сервер в России. Держит очередь, расписание, бота, заявки и журналы. Здесь лежат персональные данные, и наружу они не уходят." },
  { key: "relay", title: "Релей за границей", color: "2", modules: ["ops/relay/"], what: "Маленький посредник вне России. Через него сервер достаёт до Telegram и Instagram, а их события доходят до сервера. Данных не хранит." },
  { key: "operator", title: "Компьютер оператора", color: "5", modules: ["src/queue/mirror.mjs", "src/queue/cli.mjs", "src/gates/cli.mjs", "src/doctor.mjs"], what: "Здесь работают сессии Codex, лежат ролики и дубль расписания. Командует очередью через ключ оператора." },
  { key: "video", title: "Ролики и YouTube", color: "6", modules: ["src/video/"], what: "Главная видео-площадка. Описание ролика собирается по схеме: текст, ссылка с меткой, ссылка на бота, серия, соседние ролики. Серии и плейлисты ведутся из одного реестра." },
  { key: "comments", title: "Комментарии", color: "1", modules: ["src/comments/"], what: "Два раза в день собирает вопросы под публикациями. Отвечает человек: текст ответа готовит сессия, согласует клиент, вставляет сотрудник." },
  { key: "queue", title: "Очередь выпуска", color: "4", modules: ["src/queue/format.mjs", "src/queue/store.mjs", "src/queue/commands.mjs", "src/queue/runner.mjs", "src/queue/slots.mjs", "src/queue/ledger.mjs", "src/queue/snapshot.mjs", "src/channels/index.mjs"], what: "Единый список того, что и когда выходит. Один писатель, журнал только дописывается. Выпуск раз в пять минут берёт одобренное, чей слот наступил." },
  { key: "gates", title: "Проверки перед выходом", color: "3", modules: ["src/gates/"], what: "Пять проверок на двух постах: при постановке на согласование и прямо перед выпуском. Готовность, речь, реклама, факты, ролик." },
  { key: "approval", title: "Согласование", color: "3", modules: ["src/bot/approval.mjs"], what: "Карточка в рабочей группе. «Одобрить» нажимает ответственный со стороны клиента; без этого не выходит ничего." },
  { key: "group", title: "Рабочая группа Telegram", color: "5", modules: ["src/lib/notify.mjs", "src/lib/telegram.mjs", "src/bot/staff.mjs"], what: "Пульт завода в телефоне: согласование, заявки, отчёты, тревоги, новости, пакеты на ручную выкладку." },
  { key: "bot", title: "Бот для людей", color: "6", modules: ["src/bot/customer.mjs", "src/bot/ig-flow.mjs", "src/bot/ig-poll.mjs", "src/bot/instance.mjs", "packages/bot/"], what: "Отвечает на кодовые слова в Instagram, выдаёт материалы по ссылкам с метками и принимает заявки. По меткам видно, какая площадка привела человека." },
  { key: "leads", title: "Заявки", color: "1", modules: ["src/bot/leads.mjs", "src/leads/"], what: "Заявка сначала записывается на сервере в России, потом уходит карточкой в группу. Срок ответа стережёт отдельный сторож." },
  { key: "news", title: "Сборщик новостей", color: "5", modules: ["src/news/"], what: "Обходит ленты отрасли и блог клиента, оценивает по словарю ниши, приносит лучшее в группу. Текстов не пишет: только сырьё." },
  { key: "trends", title: "Слежение за конкурентами", color: "5", modules: ["src/trends/"], what: "Ищет у чужих каналов публикации, которые обогнали обычные для этого канала в разы. Находка — повод для своей темы." },
  { key: "metrics", title: "Цифры и отчёты", color: "4", modules: ["src/metrics/"], what: "Раз в сутки снимает цифры по вышедшему, в понедельник собирает отчёт: заявки, что сработало, что меняем." },
  { key: "storage", title: "Хранилище файлов", color: "2", modules: ["src/lib/s3.mjs", "src/media/"], what: "Публичное объектное хранилище в России. Площадки забирают ролики и картинки отсюда сами." },
  { key: "tokens", title: "Ключи площадок", color: "1", modules: ["src/tokens/", "src/lib/env.mjs", "src/lib/envfile.mjs"], what: "Сроки, продление и сверка копий ключей. Значения не печатаются нигде." },
  { key: "vault", title: "Витрина Obsidian", color: "6", modules: ["src/vault/"], what: "Это хранилище. Собирается из живого состояния раз в сутки." },
];

const RULES = [
  { key: "Готовность", what: "Текст дописан, а не оставлен каркасом.", blocks: ["заглушка вида «[здесь текст]» или «{ссылка}»", "счётчик «1/5» в конце реплики", "в ветке больше одной ссылки или ссылка не в последней реплике", "реплика длиннее предела площадки"], why: "Каркас с заглушкой однажды уехал в живой канал уже одобренным. С тех пор проверка стоит и на самом выпуске." },
  { key: "Речь", what: "Нет штампов, повторов прошлых заходов и примет конвейера.", blocks: ["фраза из списка штампов", "начало повторяет запись последних 60 дней", "хэштег или эмодзи в ветке Threads", "кодовое слово бота на любой площадке, кроме Instagram: отвечать на него умеет только она"], warns: ["оборот «не X, а Y» больше одного раза", "больше двух длинных тире", "превосходная степень без подтверждения", "одиночный пост вместо ветки", "первая фраза вопросом"], why: "Одинаковый заход площадка и читатель замечают сразу. Правило добавляется только с примером текста, на котором оно сработало." },
  { key: "Реклама", what: "На площадках с ограниченным доступом нет предложений купить.", blocks: ["цена за единицу и цена «от …»", "скидка, акция, промокод", "призыв купить, заказать, оставить заявку, позвонить", "срочность предложения", "телефон в тексте"], warns: ["слова «купить», «заказать» в рассказе"], why: "Часть 10.7 статьи 5 закона «О рекламе»: реклама на ресурсах с ограниченным доступом запрещена. Разбор и польза остаются, предложение уходит на открытые площадки и в личную переписку." },
  { key: "Факты", what: "У каждой цифры в тексте есть источник.", blocks: ["цифра, которой нет в поле facts записи", "утверждение без источника"], why: "Текст выходит от имени производителя. Цифра про покрытие, взятая из головы, это риск для клиента и для ребёнка на площадке." },
  { key: "Ролик", what: "Название, описание и ссылки ролика собраны по схеме.", blocks: ["первая строка описания повторяет число из названия: ответ виден до просмотра"], warns: ["название длиннее 80 знаков", "название называет тему, а не событие", "у ролика нет прямой ссылки: ни на статью, ни на бота", "дата в тексте ролика, который не про событие", "хэштегов больше пяти или ни одного", "хэштеги внутри текста описания", "Instagram: первая строка длиннее 60 знаков или ссылка в подписи"], why: "Замер на канале исполнителя: ролик с названием-событием набрал 3 844 просмотра, соседние ролики той же серии с названиями-темами 926 и 1 057. Число в первой строке описания видно в выдаче и снимает вопрос, ради которого ролик открывают." },
];

const ROLES = [
  { title: "Утверждающий", who: "Ответственный со стороны клиента.", does: "Нажимает «Одобрить», «Правка» или «Снять» под карточкой. Может остановить выпуск целиком командой /stop_release.", nodes: ["approval", "group"] },
  { title: "Оператор", who: "Исполнитель: ведёт сессии Codex.", does: "Готовит тексты и ролики, ставит их в очередь, чинит то, о чём пришла тревога. Ведёт дубль расписания.", nodes: ["operator", "queue", "tokens"] },
  { title: "Менеджер по заявкам", who: "Сотрудник клиента.", does: "Нажимает «Взял в работу» под карточкой заявки и связывается с человеком. Отвечает на вопросы из бота ответом на сообщение.", nodes: ["leads", "group"] },
  { title: "Владелец аккаунтов", who: "Тот, на кого оформлены соцсети клиента.", does: "Один раз входит в каждую площадку и выдаёт заводу доступ. Пароли никому не передаёт.", nodes: ["tokens"] },
];

const MATERIAL_KIND = { blog: "Статьи", news: "Новости", interview: "Интервью", case: "Кейсы", trend: "Находки", question: "Вопросы", doc: "Документы", comment: "Комментарии", video: "Ролики" };

/* ───────────────────────────── чтение источников ───────────────────────────── */

function walk(dir, test, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "test") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, test, out);
    else if (test(p)) out.push(p);
  }
  return out;
}

const rel = (root, p) => path.relative(root, p).split(path.sep).join("/");

/** Шапка модуля: первый блок комментариев после необязательной строки запуска. */
export function moduleHeader(source) {
  const lines = String(source).split(/\r?\n/);
  const out = [];
  let i = lines[0]?.startsWith("#!") ? 1 : 0;
  if (lines[i]?.trim().startsWith("/*")) {
    for (; i < lines.length; i++) {
      out.push(lines[i].replace(/^\s*\/?\*+\/?\s?/, "").replace(/\*\/\s*$/, ""));
      if (lines[i].includes("*/")) break;
    }
  } else {
    for (; i < lines.length && lines[i].trim().startsWith("//"); i++) out.push(lines[i].replace(/^\s*\/\/ ?/, ""));
  }
  return out.join("\n").trim();
}

/** Что модуль подключает и какие ключи читает. */
export function moduleLinks(source, file, root) {
  const imports = new Set();
  for (const m of String(source).matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+|#bot)["']/g)) {
    if (m[1] === "#bot") { imports.add("packages/bot/src/index.mjs"); continue; }
    imports.add(rel(root, path.resolve(path.dirname(file), m[1])));
  }
  const envNames = new Set();
  for (const m of String(source).matchAll(/\b(?:env|need|has|num|list|fingerprint)\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) envNames.add(m[1]);
  return { imports: [...imports], envNames: [...envNames] };
}

function parseFront(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?/);
  const props = {};
  if (m) for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    try { if (/^["[{]/.test(v)) v = JSON.parse(v); } catch { /* оставляем строкой */ }
    props[kv[1]] = v;
  }
  return { props, body: m ? text.slice(m[0].length) : text };
}

/** Разделы документа с заголовками третьего уровня: «### Название», затем строки «Поле: значение». */
export function parseSections(text) {
  const out = [];
  let area = "";
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.+)$/);
    const h3 = line.match(/^###\s+(.+)$/);
    if (h2) { area = h2[1].trim(); cur = null; continue; }
    if (h3) { cur = { title: h3[1].trim(), area, fields: {}, body: [] }; out.push(cur); continue; }
    if (!cur) continue;
    const field = cur.body.length === 0 && line.match(/^([А-ЯЁ][а-яё ]{1,24}):\s*(.+)$/);
    if (field) cur.fields[field[1].toLowerCase()] = field[2].trim();
    else cur.body.push(line);
  }
  return out.map((s) => ({ ...s, body: s.body.join("\n").trim() }));
}

const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8").replace(/^﻿/, "") : "");
const title1 = (text, fallback) => String(text).match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;

/** Собирает всё, из чего строится витрина. */
export function gather(root = PROJECT_ROOT, mirrorDir = path.join(root, "mirror")) {
  const m = (name, fallback) => readJson(path.join(mirrorDir, name), fallback) ?? fallback;
  const mdFiles = (dir) => walk(path.join(root, dir), (p) => p.endsWith(".md")).map((p) => ({ path: rel(root, p), text: readText(p) })).map((d) => ({ ...d, title: title1(d.text, path.basename(d.path, ".md")) }));
  const scenarios = [];
  for (const f of walk(path.join(root, "bot", "scenarios"), (p) => p.endsWith(".json"))) {
    const data = readJson(f, []);
    for (const s of Array.isArray(data) ? data : [data]) if (s) scenarios.push(s);
  }
  const reports = walk(path.join(mirrorDir, "reports", "weekly"), (p) => p.endsWith(".md")).map((p) => ({ week: path.basename(p, ".md"), md: readText(p) })).sort((a, b) => a.week.localeCompare(b.week));
  return {
    now: Date.now(),
    config: readJson(path.join(root, "zavod.config.json"), {}),
    live: Boolean(readJson(path.join(mirrorDir, "state.json"))),
    state: m("state.json", {}),
    queue: m("queue.json", []),
    ledger: m("ledger.json", []),
    metrics: m("metrics.json", []),
    metricSeries: m("metricSeries.json", []),
    followers: m("followers.json", []),
    news: m("news.json", []),
    newsHealth: m("newsHealth.json", {}),
    trends: m("trends.json", []),
    funnel: m("funnel.json", null),
    questions: m("questions.json", []),
    comments: m("comments.json", []),
    youtubeChannel: readJson(path.join(root, "content", "youtube", "channel.json"), null),
    youtubeSeries: readJson(path.join(root, "content", "youtube", "series.json"), { series: [] })?.series || [],
    tokens: m("tokens.json", []),
    alerts: m("alerts.json", []),
    reports,
    articles: walk(path.join(root, "content", "articles"), (p) => p.endsWith(".md")).map((p) => { const { props, body } = parseFront(readText(p)); return { ...props, slug: props.slug || path.basename(p, ".md"), excerpt: body.replace(/^#.*$/m, "").trim().slice(0, 700) }; }),
    modules: [...walk(path.join(root, "src"), (p) => p.endsWith(".mjs")), ...walk(path.join(root, "ops"), (p) => /\.(mjs|js)$/.test(p)), ...walk(path.join(root, "packages", "bot", "src"), (p) => p.endsWith(".mjs"))].map((p) => { const source = readText(p); return { path: rel(root, p), header: moduleHeader(source), lines: source.split("\n").length, ...moduleLinks(source, p, root) }; }),
    prompts: [...mdFiles("prompts"), ...["МАСТЕР-ПРОМПТ.md", "AGENTS.md"].filter((f) => existsSync(path.join(root, f))).map((f) => ({ path: f, text: readText(path.join(root, f)), title: title1(readText(path.join(root, f)), f) }))],
    docs: mdFiles("docs"),
    legal: mdFiles("legal"),
    scenarios,
    materials: readJson(path.join(root, "bot", "materials.json"), []) || [],
    links: readJson(path.join(root, "bot", "links.json"), {}) || {},
    sources: readJson(path.join(root, "src", "news", "sources.json"), { sources: [] })?.sources || [],
    watchlist: readJson(path.join(root, "src", "trends", "watchlist.json"), {}) || {},
    stamps: readJson(path.join(root, "src", "gates", "stamps.json"), { phrases: [] })?.phrases || [],
  };
}

/* ───────────────────────────── сборка заметок ───────────────────────────── */

/**
 * Собирает хранилище в памяти.
 * @returns {Map<string, string>} путь от корня хранилища → содержимое
 */
export function buildVault(input) {
  const files = new Map();
  const put = (p, text) => files.set(p, text.endsWith("\n") ? text : `${text}\n`);
  const cfg = input.config || {};
  const channels = cfg.channels || {};
  const now = input.now || Date.now();
  const today = mskDate(now);

  const P = {
    home: "00 Завод",
    channel: (name) => `Площадки/${safe(channels[name]?.title || name)}`,
    session: (s) => `Сессии/${safe(`${s.id} ${s.title}`)}`,
    node: (key) => `Узлы/${safe(NODES.find((n) => n.key === key)?.title || key)}`,
    module: (p) => `Код/${p}`,
    key: (name) => `Ключи/${name}`,
    cron: (c) => `Расписания/${safe(c.id)}`,
    rule: (key) => `Правила/Проверка «${key}»`,
    role: (r) => `Люди/${safe(r.title)}`,
    day: (date) => `Расписание/${date}`,
    scenario: (s) => `Бот/Кодовые слова/${safe(String(s["ключ"] || s.key || "слово").toUpperCase())}`,
    botMaterial: (m) => `Бот/Материалы/${safe(m.title || m.key)}`,
    article: (slug) => `Материалы/Статьи/${safe(slug)}`,
    report: (week) => `Отчёты/Неделя с ${week}`,
    doc: (d) => `Документы/${safe(path.basename(d.path, ".md"))}`,
    prompt: (d) => `Промпты/${safe(path.basename(d.path, ".md"))}`,
  };
  const channelNames = Object.keys(channels);
  const chanTitle = (name) => channels[name]?.title || name;
  const knownModules = new Set((input.modules || []).map((m) => m.path));
  const knownKeys = new Set(REGISTRY.map((r) => r.name));
  const sessions = cfg.sessions || [];
  const sessionOf = (channel) => sessions.find((s) => s.id === channels[channel]?.session);
  // YouTube: опись канала и реестр серий лежат в проекте, а не в снимке с сервера.
  const yt = input.youtubeChannel;
  const ytSeries = (input.youtubeSeries || []).filter((s) => s && s.key);
  const seriesPath = (s) => `YouTube/Серии/${safe(s.title || s.key)}`;
  const hasYoutube = Boolean(yt || ytSeries.length);

  /* Материал записи → заметка. Чего нет, создаётся заглушкой: связь важнее пустоты. */
  const articleBySlug = new Map((input.articles || []).map((a) => [a.slug, a]));
  const materialUse = new Map(); // путь заметки материала → публикации
  const stubs = new Map();
  function materialNote(material) {
    const raw = String(material || "").trim();
    if (!raw) return null;
    const [kind, ...rest] = raw.split(":");
    const idPart = rest.join(":").trim();
    if (kind === "blog" && articleBySlug.has(idPart)) return P.article(idPart);
    const folder = MATERIAL_KIND[kind] || "Прочее";
    const p = `Материалы/${folder}/${safe(idPart || raw)}`;
    if (!stubs.has(p)) stubs.set(p, { raw, kind, id: idPart });
    return p;
  }

  /* ── Публикации ── */
  const metricById = new Map((input.metrics || []).map((r) => [r.id, r]));
  const ledgerById = new Map();
  for (const r of input.ledger || []) if (r.status === "published" || r.status === "link") ledgerById.set(r.id, { ...(ledgerById.get(r.id) || {}), ...r });
  const pubPath = (e) => `Публикации/${safe(`${e.date} ${String(e.time || "").replace(":", "")} ${chanTitle(e.channel)} · ${e.name}`)}`;
  const queue = (input.queue || []).filter((e) => e && e.id && e.channel);
  const dayWindow = { from: addDays(today, -21), to: addDays(today, 30) };
  const days = new Map();
  const usualViews = {};
  for (const name of channelNames) usualViews[name] = median(queue.filter((e) => e.channel === name).map((e) => metricById.get(e.id)?.views).filter(Number.isFinite));

  for (const e of queue) {
    const p = pubPath(e);
    const mat = materialNote(e.material);
    if (mat) { if (!materialUse.has(mat)) materialUse.set(mat, []); materialUse.get(mat).push(e); }
    const inWindow = e.date >= dayWindow.from && e.date <= dayWindow.to && e.status !== "cancelled";
    if (inWindow) { if (!days.has(e.date)) days.set(e.date, []); days.get(e.date).push(e); }
    const numbers = metricById.get(e.id) || {};
    const led = ledgerById.get(e.id) || {};
    const url = e.result?.link || led.link || "";
    const verdict = checkAll(e, { stamps: input.stamps || [], restricted: channels[e.channel]?.access === "restricted", codeWords: (input.scenarios || []).flatMap((s) => s["слова"] || s.words || []) });
    const s = sessionOf(e.channel);
    const L = [frontmatter({
      type: "публикация",
      channel: link(P.channel(e.channel), chanTitle(e.channel)),
      status: STATUS_TITLE[e.status] || e.status,
      date: e.date,
      time: e.time,
      kind: e.kind,
      material: mat ? link(mat) : undefined,
      session: s ? link(P.session(s), s.id) : undefined,
      views: Number.isFinite(numbers.views) ? numbers.views : undefined,
      url,
      tags: ["публикация", tag(e.channel), `статус/${tag(STATUS_TITLE[e.status] || e.status)}`],
    })];
    L.push(`# ${preview(e, 80)}`, "");
    L.push(`${link(P.channel(e.channel), chanTitle(e.channel))} · ${inWindow ? link(P.day(e.date), `${e.date.slice(8)}.${e.date.slice(5, 7)}`) : e.date} в ${e.time} · **${STATUS_TITLE[e.status] || e.status}**${mat ? ` · материал: ${link(mat)}` : ""}`, "");
    if (url) L.push(`Вышло: ${url}`, "");
    if (e.approval?.name) L.push(callout("success", "Согласовано", `${e.approval.name}, ${String(e.approval.at || "").slice(0, 16).replace("T", " ")} UTC`), "");
    if (e.status === "rework" && e.note) L.push(callout("warning", "Правка от утверждающего", String(e.note)), "");
    if (["failed", "expired"].includes(e.status) && e.note) L.push(callout("failure", "Не вышло", String(e.note)), "");
    L.push("## Текст", "");
    if (e.kind === "thread") (e.posts || []).forEach((t, i) => L.push(`**${i + 1}.** ${t}`, ""));
    else L.push(e.title ? `**${e.title}**\n` : "", String(e.text || "").replace(/<[^>]+>/g, ""), "");
    for (const m of e.media || []) L.push(`- ${m.type === "video" ? "ролик" : "картинка"}: ${m.url}`);
    const facts = (e.facts || []).filter((f) => f?.claim);
    if (facts.length) L.push("", "## Откуда цифры", "", table(["Утверждение", "Источник"], facts.map((f) => [f.claim, f.source || "не указан"])));
    L.push("", "## Проверки", "");
    L.push(verdict.block.length ? verdict.block.map((b) => `- ⛔ ${b}`).join("\n") : `Пройдены: ${RULES.map((r) => link(P.rule(r.key), r.key.toLowerCase())).join(", ")}.`);
    if (verdict.warn.length) L.push("", verdict.warn.map((w) => `- ⚠️ ${w}`).join("\n"));
    if (Number.isFinite(numbers.views)) {
      const usual = usualViews[e.channel];
      L.push("", "## Цифры", "", table(["Показатель", "Значение"], [
        ["Просмотры", `${num(numbers.views)}${usual ? ` (обычно ${num(usual)}, это ${(numbers.views / usual).toFixed(1).replace(".", ",")}×)` : ""}`],
        ...["likes", "replies", "comments", "reposts", "shares", "saves", "reach", "watchPct", "avgSec", "subs"].filter((k) => Number.isFinite(numbers[k])).map((k) => [{ likes: "Отметки", replies: "Ответы", comments: "Комментарии", reposts: "Репосты", shares: "Пересылки", saves: "Сохранения", reach: "Охват", watchPct: "Досмотр, %", avgSec: "Среднее время просмотра, с", subs: "Подписались с ролика" }[k], num(numbers[k])]),
        ["Замер", numbers.day || ""],
      ]));
      const series = (input.metricSeries || []).filter((r) => r.id === e.id && Number.isFinite(r.views));
      if (series.length > 2) {
        const max = Math.max(...series.map((r) => r.views));
        L.push("", "Как набирались просмотры:", "", "```", ...series.map((r) => `${r.day}  ${bar(r.views, max, 24)}  ${num(r.views)}`), "```");
      }
    }
    L.push("", `_Номер записи в очереди: \`${e.id}\`. ${AUTO}_`);
    put(`${p}.md`, L.join("\n"));
  }

  /* ── Дни расписания ── */
  const dayList = [...days.keys()].sort();
  const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  dayList.forEach((date, i) => {
    const entries = days.get(date).sort((a, b) => dueAt(a) - dueAt(b));
    const wd = WEEKDAYS[new Date(Date.parse(`${date}T12:00:00+03:00`)).getUTCDay()];
    const L = [frontmatter({ type: "день", date, posts: entries.length, tags: ["расписание"] }), `# ${date.slice(8)}.${date.slice(5, 7)}, ${wd}`, ""];
    const nav = [dayList[i - 1] ? `← ${link(P.day(dayList[i - 1]))}` : "", date === today ? "**сегодня**" : "", dayList[i + 1] ? `${link(P.day(dayList[i + 1]))} →` : ""].filter(Boolean).join(" · ");
    if (nav) L.push(nav, "");
    L.push(table(["Время", "Площадка", "Статус", "Что выходит"], entries.map((e) => [e.time, cellLink(P.channel(e.channel), chanTitle(e.channel)), STATUS_TITLE[e.status] || e.status, cellLink(pubPath(e), preview(e, 60))])));
    L.push("", `_${AUTO}_`);
    put(`${P.day(date)}.md`, L.join("\n"));
  });

  /* ── Площадки ── */
  const lastFollowers = {};
  for (const f of input.followers || []) if (Number.isFinite(f.count)) lastFollowers[f.channel] = f;
  for (const name of channelNames) {
    const c = channels[name];
    const mine = queue.filter((e) => e.channel === name);
    const published = mine.filter((e) => e.status === "published");
    const week = published.filter((e) => now - dueAt(e) < 7 * 86_400_000).length;
    const upcoming = mine.filter((e) => ["approved", "review"].includes(e.status) && dueAt(e) > now).sort((a, b) => dueAt(a) - dueAt(b));
    const best = published.map((e) => ({ e, v: metricById.get(e.id)?.views })).filter((x) => Number.isFinite(x.v)).sort((a, b) => b.v - a.v).slice(0, 5);
    const s = sessionOf(name);
    const keys = (c.tokens || []).map((t) => String(t).split(" ")[0]).filter((t) => knownKeys.has(t));
    const L = [frontmatter({ type: "площадка", access: c.access === "restricted" ? "ограниченный доступ" : "открытая", session: s ? link(P.session(s), s.id) : undefined, per_day: c.perDay, published: published.length, followers: lastFollowers[name]?.count, tags: ["площадка", c.access === "restricted" ? "реклама-запрещена" : "реклама-разрешена"] })];
    L.push(`# ${c.title}`, "");
    L.push(callout(c.access === "restricted" ? "warning" : "tip", c.access === "restricted" ? "Только экспертное" : "Можно предлагать", c.adPolicy || ""), "");
    L.push(table(["Что", "Значение"], [
      ["Ведёт сессия", s ? cellLink(P.session(s), `${s.id} ${s.title}`) : "—"],
      ["Что выходит", (c.kinds || []).join(", ")],
      ["Слоты по Москве", (c.slots || []).join(", ")],
      ["Потолок в сутки", c.perDay],
      ["Пауза между выходами", `${c.minGapMin} мин`],
      ["Как достаём до площадки", c.reach || ""],
      ["Что измеряем", (c.metrics || []).join(", ") || "снимается руками"],
      ["Состояние кода", c.status || ""],
      ["Адаптер", knownModules.has(c.adapter) ? cellLink(P.module(c.adapter), c.adapter) : c.adapter],
      ["Подписчики", lastFollowers[name] ? `${num(lastFollowers[name].count)} на ${lastFollowers[name].day}` : "не измерено"],
    ]), "");
    if (keys.length) L.push("## Ключи", "", keys.map((k) => `- ${link(P.key(k), k)}`).join("\n"), "");
    if (name === "youtube" && hasYoutube) L.push("## Канал и серии", "", `- ${link("YouTube/Канал", "Опись канала")}: что на нём лежит и что уже заходило`, ...ytSeries.map((s) => `- ${link(seriesPath(s), s.title || s.key)}`), "");
    if (c.rules) L.push("## Правила площадки", "", String(c.rules), "");
    L.push("## Сейчас", "", `Вышло всего: **${published.length}**, за семь дней: **${week}**. Обычный пост набирает ${usualViews[name] ? num(usualViews[name]) : "—"} просмотров.`, "");
    if (upcoming.length) L.push("Ближайшее в очереди:", "", table(["Когда", "Статус", "Что"], upcoming.slice(0, 8).map((e) => [`${e.date.slice(8)}.${e.date.slice(5, 7)} ${e.time}`, STATUS_TITLE[e.status], cellLink(pubPath(e), preview(e, 60))])), "");
    else L.push("В очереди на площадку пусто.", "");
    if (best.length) {
      const max = best[0].v;
      L.push("Лучшее:", "", table(["Просмотры", "", "Что"], best.map((x) => [num(x.v), bar(x.v, max, 14), cellLink(pubPath(x.e), preview(x.e, 56))])), "");
    }
    L.push(`_${AUTO}_`);
    put(`${P.channel(name)}.md`, L.join("\n"));
  }

  /* ── Сессии Codex ── */
  const promptByPath = new Map((input.prompts || []).map((p) => [p.path, p]));
  for (const s of sessions) {
    const own = channelNames.filter((n) => channels[n].session === s.id);
    const prompt = promptByPath.get(s.prompt);
    const L = [frontmatter({ type: "сессия", id: s.id, tags: ["сессия"] }), `# ${s.id}. ${s.title}`, "", s.what || "", ""];
    if (own.length) L.push("## Площадки", "", own.map((n) => `- ${link(P.channel(n), chanTitle(n))}`).join("\n"), "");
    L.push("## Промпт сессии", "", prompt ? `${link(P.prompt(prompt), prompt.title)} · файл \`${s.prompt}\`` : `Файл \`${s.prompt}\` ещё не написан.`, "");
    const mineQueue = queue.filter((e) => own.includes(e.channel));
    if (mineQueue.length) L.push("## В очереди от этой сессии", "", table(["Статус", "Записей"], Object.entries(mineQueue.reduce((a, e) => { a[STATUS_TITLE[e.status] || e.status] = (a[STATUS_TITLE[e.status] || e.status] || 0) + 1; return a; }, {})).map(([k, v]) => [k, v])), "");
    L.push(`_${AUTO}_`);
    put(`${P.session(s)}.md`, L.join("\n"));
  }

  /* ── Промпты и документы: копии, чтобы витрина читалась без проекта ── */
  const copyDocs = (list, pathOf, kind) => {
    for (const d of list || []) {
      const body = d.text.replace(/^---\n[\s\S]*?\n---\n/, "");
      put(`${pathOf(d)}.md`, `${frontmatter({ type: kind, source: d.path, tags: [tag(kind)] })}${callout("note", "Копия", `Хозяин текста — файл \`${d.path}\` в проекте. ${AUTO}`)}\n\n${body}`);
    }
  };
  copyDocs(input.prompts, P.prompt, "промпт");
  copyDocs([...(input.docs || []), ...(input.legal || [])], P.doc, "документ");

  /* ── Код: модули, их связи и ключи ── */
  const nodeOfModule = (p) => NODES.find((n) => n.modules.some((prefix) => (prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix)));
  const channelOfModule = (p) => channelNames.find((n) => channels[n].adapter === p);
  const cronOfModule = (p) => (cfg.cron || []).filter((c) => String(c.run || "").includes(p));
  const usedBy = new Map();
  for (const m of input.modules || []) for (const imp of m.imports) { if (!usedBy.has(imp)) usedBy.set(imp, []); usedBy.get(imp).push(m.path); }
  for (const m of input.modules || []) {
    const node = nodeOfModule(m.path);
    const ch = channelOfModule(m.path);
    const L = [frontmatter({ type: "модуль", lines: m.lines, node: node ? link(P.node(node.key), node.title) : undefined, tags: ["код", tag(m.path.split("/").slice(0, 2).join("/"))] }), `# ${m.path}`, ""];
    const where = [node ? `Узел: ${link(P.node(node.key), node.title)}` : "", ch ? `Площадка: ${link(P.channel(ch), chanTitle(ch))}` : "", ...cronOfModule(m.path).map((c) => `Расписание: ${link(P.cron(c), c.id)}`)].filter(Boolean);
    if (where.length) L.push(where.join(" · "), "");
    if (m.header) L.push("## Что делает и почему так", "", "```text", m.header, "```", "");
    const imports = m.imports.filter((p) => knownModules.has(p));
    if (imports.length) L.push("## Подключает", "", imports.map((p) => `- ${link(P.module(p), p)}`).join("\n"), "");
    const users = (usedBy.get(m.path) || []).filter((p) => knownModules.has(p));
    if (users.length) L.push("## Кто его подключает", "", users.map((p) => `- ${link(P.module(p), p)}`).join("\n"), "");
    const keys = m.envNames.filter((k) => knownKeys.has(k));
    if (keys.length) L.push("## Читает ключи", "", keys.map((k) => `- ${link(P.key(k), k)}`).join("\n"), "");
    L.push(`_Строк: ${m.lines}. ${AUTO}_`);
    put(`${P.module(m.path)}.md`, L.join("\n"));
  }

  /* ── Ключи ── */
  const tokenState = new Map((input.tokens || []).map((t) => [t.name, t]));
  for (const r of REGISTRY) {
    const st = tokenState.get(r.name);
    const readers = (input.modules || []).filter((m) => m.envNames.includes(r.name)).map((m) => m.path);
    const ch = r.need.startsWith("channel:") ? r.need.split(":")[1] : "";
    const L = [frontmatter({ type: "ключ", secret: r.secret, where: r.where.map((w) => ({ server: "сервер", operator: "компьютер оператора", relay: "релей" })[w] || w), days_left: st?.daysLeft ?? undefined, tags: ["ключ", r.secret ? "секрет" : "настройка"] }), `# ${r.name}`, "", r.what, ""];
    L.push(table(["Что", "Значение"], [
      ["Секрет", r.secret ? "да: значение не печатается и в git не попадает" : "нет, это настройка"],
      ["Где живёт", r.where.map((w) => ({ server: cellLink(P.node("server"), "сервер"), operator: cellLink(P.node("operator"), "компьютер оператора"), relay: cellLink(P.node("relay"), "релей") })[w] || w).join(", ")],
      ["Когда нужен", r.need === "core" ? "всегда" : ch && channels[ch] ? `когда подключена площадка ${cellLink(P.channel(ch), chanTitle(ch))}` : "по желанию"],
      ["Состояние на сервере", st ? st.status : "снимка с сервера нет"],
      ...(r.expires ? [["Срок ведёт", cellLink(P.key(r.expires), r.expires)]] : []),
    ]), "");
    if (readers.length) L.push("## Кто читает", "", readers.map((p) => `- ${link(P.module(p), p)}`).join("\n"), "");
    L.push(`_${AUTO}_`);
    put(`${P.key(r.name)}.md`, L.join("\n"));
  }

  /* ── Расписания ── */
  for (const c of cfg.cron || []) {
    const mod = (input.modules || []).find((m) => String(c.run || "").includes(m.path));
    const L = [frontmatter({ type: "расписание", where: c.where, tags: ["расписание-задача"] }), `# ${c.id}`, "", c.why || "", "", table(["Что", "Значение"], [["Где", c.where === "сервер" ? cellLink(P.node("server"), "сервер") : cellLink(P.node("operator"), c.where)], ["Когда", c.when], ["Что запускает", mod ? cellLink(P.module(mod.path), c.run) : `\`${c.run}\``]]), "", `_${AUTO}_`];
    put(`${P.cron(c)}.md`, L.join("\n"));
  }

  /* ── Узлы карты ── */
  const lessons = (input.docs || []).filter((d) => /ГРАБЛИ|ОПЫТ/i.test(d.path)).flatMap((d) => parseSections(d.text));
  const risks = (input.docs || []).filter((d) => /РИСК/i.test(d.path)).flatMap((d) => parseSections(d.text));
  const lessonPath = (l) => `Грабли/${safe(l.title)}`;
  const riskPath = (r) => `Риски/${safe(r.title)}`;
  const whereOf = (s) => String(s.fields["где"] || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const whereLinks = (s) => whereOf(s).map((w) => (channels[w] ? link(P.channel(w), chanTitle(w)) : NODES.some((n) => n.key === w) ? link(P.node(w), NODES.find((n) => n.key === w).title) : "")).filter(Boolean);
  for (const n of NODES) {
    const mods = (input.modules || []).filter((m) => nodeOfModule(m.path)?.key === n.key);
    const keys = [...new Set(mods.flatMap((m) => m.envNames).filter((k) => knownKeys.has(k)))];
    const crons = (cfg.cron || []).filter((c) => mods.some((m) => String(c.run || "").includes(m.path)));
    const myLessons = lessons.filter((l) => whereOf(l).includes(n.key));
    const L = [frontmatter({ type: "узел", modules: mods.length, tags: ["узел"] }), `# ${n.title}`, "", n.what, ""];
    if (mods.length) L.push("## Модули", "", mods.map((m) => `- ${link(P.module(m.path), m.path)}`).join("\n"), "");
    if (crons.length) L.push("## По расписанию", "", crons.map((c) => `- ${link(P.cron(c), c.id)}: ${c.when}`).join("\n"), "");
    if (keys.length) L.push("## Ключи", "", keys.map((k) => `- ${link(P.key(k), k)}`).join("\n"), "");
    if (n.key === "gates") L.push("## Проверки", "", RULES.map((r) => `- ${link(P.rule(r.key), r.key)}: ${r.what}`).join("\n"), "");
    if (n.key === "queue") L.push("## Статусы записи", "", link("Правила/Статусы записи"), "");
    if (n.key === "video" && hasYoutube) L.push("## Канал и серии", "", `- ${link("YouTube/Канал", "Опись канала")}`, ...ytSeries.map((s) => `- ${link(seriesPath(s), s.title || s.key)}`), "");
    if (n.key === "comments") L.push("## Что сейчас ждёт ответа", "", link("Новости/Комментарии", "Комментарии под публикациями"), "");
    const people = ROLES.filter((r) => r.nodes.includes(n.key));
    if (people.length) L.push("## Кто работает с узлом", "", people.map((r) => `- ${link(P.role(r), r.title)}`).join("\n"), "");
    if (myLessons.length) L.push("## На чём здесь уже обжигались", "", myLessons.map((l) => `- ${link(lessonPath(l), l.title)}`).join("\n"), "");
    L.push(`_${AUTO}_`);
    put(`${P.node(n.key)}.md`, L.join("\n"));
  }

  /* ── Люди ── */
  for (const r of ROLES) put(`${P.role(r)}.md`, [frontmatter({ type: "роль", tags: ["роль"] }), `# ${r.title}`, "", r.who, "", r.does, "", "## Работает с", "", r.nodes.map((k) => `- ${link(P.node(k), NODES.find((n) => n.key === k).title)}`).join("\n"), "", `_${AUTO}_`].join("\n"));

  /* ── Правила ── */
  for (const r of RULES) {
    const L = [frontmatter({ type: "правило", tags: ["правило"] }), `# Проверка «${r.key}»`, "", r.what, "", callout("quote", "Почему она есть", r.why), "", "## Останавливает запись", "", r.blocks.map((b) => `- ${b}`).join("\n")];
    if (r.warns) L.push("", "## Показывает человеку как замечание", "", r.warns.map((b) => `- ${b}`).join("\n"));
    if (r.key === "Речь") L.push("", `Список штампов: ${link("Правила/Список штампов")}.`);
    if (r.key === "Реклама") L.push("", "## Где действует", "", channelNames.filter((n) => channels[n].access === "restricted").map((n) => `- ${link(P.channel(n), chanTitle(n))}`).join("\n"));
    L.push("", `Узел: ${link(P.node("gates"), "Проверки перед выходом")}.`, "", `_${AUTO}_`);
    put(`${P.rule(r.key)}.md`, L.join("\n"));
  }
  put("Правила/Список штампов.md", [frontmatter({ type: "правило", tags: ["правило"] }), "# Список штампов", "", `Фраз в списке: ${(input.stamps || []).length}. Запись с любой из них дальше не идёт. Файл: \`src/gates/stamps.json\`.`, "", (input.stamps || []).map((s) => `- «${s.phrase}»${s.why ? `: ${s.why}` : ""}`).join("\n") || "_список пуст_", "", `Проверка: ${link(P.rule("Речь"), "речь")}.`, "", `_${AUTO}_`].join("\n"));
  {
    const moves = [];
    for (const a of STATUSES) for (const b of STATUSES) if (canMove(a, b)) moves.push(`    ${a} --> ${b}`);
    const L = [frontmatter({ type: "правило", tags: ["правило"] }), "# Статусы записи", "", "Запись двигается только по этой схеме. Всё остальное сервер отклоняет как отказ по правилу.", "", "```mermaid", "stateDiagram-v2", "    [*] --> draft", ...moves, "    published --> [*]", "    cancelled --> [*]", "```", "", table(["Статус", "Что значит", "Записей сейчас"], STATUSES.map((s) => [`\`${s}\``, STATUS_TITLE[s], queue.filter((e) => e.status === s).length])), "", `Узел: ${link(P.node("queue"), "Очередь выпуска")} · ${link(P.node("approval"), "Согласование")}.`, "", `_${AUTO}_`];
    put("Правила/Статусы записи.md", L.join("\n"));
  }

  /* ── Грабли и риски ── */
  for (const l of lessons) put(`${lessonPath(l)}.md`, [frontmatter({ type: "грабля", area: l.area, from: l.fields["откуда"], tags: ["грабля", ...whereOf(l).map(tag)] }), `# ${l.title}`, "", l.fields["откуда"] ? `_Откуда: ${l.fields["откуда"]}_\n` : "", l.body, "", whereLinks(l).length ? `Касается: ${whereLinks(l).join(", ")}.` : "", "", `_${AUTO}_`].join("\n"));
  for (const r of risks) put(`${riskPath(r)}.md`, [frontmatter({ type: "риск", area: r.area, chance: r.fields["вероятность"], tags: ["риск"] }), `# ${r.title}`, "", ...Object.entries(r.fields).filter(([k]) => k !== "где").map(([k, v]) => `**${k[0].toUpperCase()}${k.slice(1)}:** ${v}\n`), r.body, "", whereLinks(r).length ? `Касается: ${whereLinks(r).join(", ")}.` : "", "", `_${AUTO}_`].join("\n"));

  /* ── Материалы: статьи сайта и всё остальное ── */
  const usedList = (p) => (materialUse.get(p) || []).sort((a, b) => dueAt(a) - dueAt(b));
  for (const a of input.articles || []) {
    const p = P.article(a.slug);
    const used = usedList(p);
    const L = [frontmatter({ type: "материал", kind: "статья сайта", url: a.url, published: a.published, words: Number(a.words) || undefined, used: used.length, tags: ["материал", "статья", used.length ? "использован" : "не-использован"] }), `# ${a.title || a.slug}`, "", `${a.url || ""}${a.published ? ` · ${a.published}` : ""}${a.words ? ` · слов: ${a.words}` : ""}`, ""];
    L.push(used.length ? `## Что из неё сделано (${used.length})` : "## Что из неё сделано", "", used.length ? table(["Когда", "Площадка", "Статус", "Публикация"], used.map((e) => [`${e.date} ${e.time}`, cellLink(P.channel(e.channel), chanTitle(e.channel)), STATUS_TITLE[e.status] || e.status, cellLink(pubPath(e), preview(e, 50))])) : "Пока ничего: статья ждёт своей очереди в банке тем.", "");
    if (a.excerpt) L.push("## Начало статьи", "", a.excerpt.split("\n").map((l) => `> ${l}`).join("\n"), "", `Полный текст: \`content/articles/${a.slug}.md\`.`, "");
    L.push(`_${AUTO}_`);
    put(`${p}.md`, L.join("\n"));
  }
  const newsById = new Map((input.news || []).map((n) => [n.id, n]));
  const commentById = new Map((input.comments || []).filter((c) => c && c.id).map((c) => [String(c.id), c]));
  for (const [p, s] of stubs) {
    const used = usedList(p);
    const news = s.kind === "news" ? newsById.get(s.id) : null;
    const comment = s.kind === "comment" ? commentById.get(s.id) : null;
    const head = news
      ? `${news.sourceTitle || news.source} · ${String(news.published || news.at).slice(0, 10)}\n${news.url}`
      : comment
        ? `${channels[comment.platform] ? link(P.channel(comment.platform), chanTitle(comment.platform)) : comment.platform} · ${String(comment.at).slice(0, 10)}\n\n> ${String(comment.text).replace(/\s+/g, " ").slice(0, 600)}\n\n${comment.link}`
        : `Обозначение в очереди: \`${s.raw}\`.`;
    const L = [frontmatter({ type: "материал", kind: MATERIAL_KIND[s.kind] || "прочее", used: used.length, url: news?.url || comment?.link, tags: ["материал", tag(MATERIAL_KIND[s.kind] || "прочее")] }), `# ${news?.title || (comment ? `Комментарий от ${String(comment.at).slice(0, 10)}` : s.id || s.raw)}`, "", head, "", `## Что из этого сделано (${used.length})`, "", table(["Когда", "Площадка", "Статус", "Публикация"], used.map((e) => [`${e.date} ${e.time}`, cellLink(P.channel(e.channel), chanTitle(e.channel)), STATUS_TITLE[e.status] || e.status, cellLink(pubPath(e), preview(e, 50))])), "", `_${AUTO}_`];
    put(`${p}.md`, L.join("\n"));
  }

  /* ── Новости и находки ── */
  {
    const inbox = [...newsById.values()];
    const byStatus = (st) => inbox.filter((n) => n.status === st).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const row = (n) => [String(n.published || n.at).slice(0, 10), n.sourceTitle || n.source, n.score, `[${String(n.title).replace(/[[\]|]/g, " ").slice(0, 90)}](${n.url})`, (n.tags || []).join(", ")];
    const L = [frontmatter({ type: "сводка", tags: ["новости"] }), "# Ящик новостей", "", `Узел: ${link(P.node("news"), "Сборщик новостей")}. Сборщик приносит сырьё, решает человек кнопкой в группе.`, "", table(["Статус", "Записей"], [["новые", byStatus("new").length], ["показаны в группе", byStatus("sent").length], ["взяты в работу", byStatus("taken").length], ["мимо", byStatus("skipped").length], ["стали материалом", byStatus("used").length]]), ""];
    for (const [st, title] of [["taken", "Взяты в работу"], ["sent", "Показаны, ждут решения"], ["used", "Стали материалом"]]) {
      const list = byStatus(st).slice(0, 40);
      if (list.length) L.push(`## ${title}`, "", table(["Дата", "Источник", "Оценка", "Заголовок", "Темы"], list.map(row)), "");
    }
    const health = input.newsHealth || {};
    if ((input.sources || []).length) L.push("## Источники", "", table(["Источник", "Вид", "Вес", "Последний проход", "Состояние"], input.sources.map((s) => [s.title || s.id, s.type || "лента", s.weight ?? 0, String(health[s.id]?.ok || "").slice(0, 10) || "—", (health[s.id]?.fails || 0) >= 3 ? `молчит: ${health[s.id].error || ""}` : s.enabled === false ? "выключен" : "работает"])), "");
    L.push(`_${AUTO}_`);
    put("Новости/Ящик новостей.md", L.join("\n"));

    const found = (input.trends || []).filter((t) => t.ratio).sort((a, b) => b.ratio - a.ratio).slice(0, 60);
    const T = [frontmatter({ type: "сводка", tags: ["находки"] }), "# Что зашло у других", "", `Узел: ${link(P.node("trends"), "Слежение за конкурентами")}. Число — во сколько раз публикация обогнала обычную для своего канала.`, "", found.length ? table(["Раз", "", "Где", "Канал", "Дата", "Что"], found.map((t) => [`${String(t.ratio).replace(".", ",")}×`, bar(Math.min(t.ratio, 12), 12, 10), t.source, t.channel, String(t.published || "").slice(0, 10), `[${String(t.title).replace(/[[\]|]/g, " ").slice(0, 80)}](${t.url})`])) : "Находок пока нет: список каналов в `src/trends/watchlist.json` пуст или ни у кого не было выброса.", "", `_${AUTO}_`];
    put("Новости/Что зашло у других.md", T.join("\n"));

    const q = (input.questions || []).slice(-60).reverse();
    put("Новости/Вопросы людей.md", [frontmatter({ type: "сводка", tags: ["вопросы"] }), "# Вопросы людей из бота", "", "Обезличено: без автора, телефоны и имена аккаунтов вычищены на сервере. Каждый повторяющийся вопрос — готовая тема.", "", q.length ? q.map((x) => `- ${x.day}: «${x.text}»`).join("\n") : "Вопросов пока не было.", "", `Узел: ${link(P.node("bot"), "Бот для людей")}.`, "", `_${AUTO}_`].join("\n"));
  }

  /* ── Комментарии под публикациями ── */
  {
    const list = (input.comments || []).filter((c) => c && c.id);
    const title = (p) => (channels[p] ? chanTitle(p) : p);
    const where = (p) => (channels[p] ? cellLink(P.channel(p), chanTitle(p)) : p);
    const count = (st) => list.filter((c) => c.status === st).length;
    const open = list.filter((c) => c.status === "new").sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const byPlatform = Object.entries(list.reduce((a, c) => { a[c.platform] = (a[c.platform] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]);
    const L = [frontmatter({ type: "сводка", open: open.length, tags: ["комментарии"] }), "# Комментарии под публикациями", "", `Узел: ${link(P.node("comments"), "Комментарии")}. Здесь только текст и ссылка: имя и аккаунт автора сборщик не сохраняет.`, ""];
    if (!list.length) L.push(input.live ? "Комментариев пока не было." : callout("info", "Живых данных нет", "Снимок с сервера ещё не снят: `npm run mirror`."), "");
    else {
      L.push(table(["Состояние", "Сколько"], [["ждут ответа", count("new")], ["ответили", count("answered")], ["ответ не нужен", count("skipped")]]), "");
      if (byPlatform.length) L.push("## По площадкам", "", table(["Площадка", "Комментариев", ""], byPlatform.map(([p, n]) => [where(p), n, bar(n, byPlatform[0][1], 16)])), "");
      if (open.length) L.push("## Ждут ответа", "", table(["Дата", "Площадка", "Комментарий"], open.slice(0, 40).map((c) => [String(c.at).slice(0, 10), title(c.platform), `[${String(c.text).replace(/[[\]|]/g, " ").replace(/\s+/g, " ").slice(0, 140)}](${c.link})`])), "");
    }
    L.push(`_${AUTO}_`);
    put("Новости/Комментарии.md", L.join("\n"));
  }

  /* ── YouTube: канал клиента и серии ── */
  if (hasYoutube) {
    const list = yt?.list || [];
    const videoById = new Map(list.map((v) => [v.id, v]));
    const seriesOfVideo = new Map();
    for (const s of ytSeries) for (const v of s.videos || []) if (!seriesOfVideo.has(v.id)) seriesOfVideo.set(v.id, s);
    const watch = (id) => `https://www.youtube.com/watch?v=${id}`;
    const ext = (text, url) => `[${String(text).replace(/[[\]|]/g, " ").replace(/\s+/g, " ").slice(0, 90)}](${url})`;
    const ours = queue.filter((e) => e.channel === "youtube");
    const sumViews = (s) => (s.videos || []).reduce((a, v) => a + (videoById.get(v.id)?.views ?? v.views ?? 0), 0);

    const L = [frontmatter({ type: "канал", subscribers: yt?.subscribers, videos: yt?.videos, median: yt?.medianViews, taken: yt?.taken ? String(yt.taken).slice(0, 10) : undefined, tags: ["youtube"] }), `# YouTube: канал «${yt?.title || cfg.client?.name || ""}»`, ""];
    L.push(`Главная видео-площадка завода. ${channels.youtube ? `Площадка: ${link(P.channel("youtube"), chanTitle("youtube"))} · ` : ""}узел: ${link(P.node("video"), "Ролики и YouTube")}.`, "");
    if (yt) {
      const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
      L.push(`## Опись на ${String(yt.taken || "").slice(0, 10)}`, "", table(["Что", "Значение"], [
        ["Подписчиков", num(yt.subscribers)],
        ["Роликов", num(yt.videos)],
        ["Из них коротких (до трёх минут)", num(yt.shorts)],
        ["Обычный ролик набирает", `${num(yt.medianViews)} просмотров`],
        ["Обычная длина ролика", `${num(median(list.map((v) => v.seconds)))} с`],
        ["Разложено по сериям", `${seriesOfVideo.size} из ${list.length}`],
      ]), "");
      const years = new Map();
      for (const v of list) { const y = String(v.date || "").slice(0, 4) || "—"; const cur = years.get(y) || { n: 0, views: 0 }; cur.n++; cur.views += v.views || 0; years.set(y, cur); }
      const yearRows = [...years.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const maxViews = Math.max(1, ...yearRows.map(([, v]) => v.views));
      if (yearRows.length) L.push("## По годам", "", table(["Год", "Роликов", "Просмотров", ""], yearRows.map(([y, v]) => [y, v.n, num(v.views), bar(v.views, maxViews, 20)])), "");
      const top = [...list].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 15);
      if (top.length) L.push("## Что уже заходило", "", "Число раз — во сколько ролик обогнал обычный для этого канала. Это готовые подсказки, какие темы снимать снова.", "", table(["Просмотры", "Раз", "Дата", "Ролик", "Серия"], top.map((v) => [num(v.views), yt.medianViews ? `${(v.views / yt.medianViews).toFixed(1).replace(".", ",")}×` : "", v.date || "", ext(v.title, v.url || watch(v.id)), seriesOfVideo.has(v.id) ? cellLink(seriesPath(seriesOfVideo.get(v.id)), seriesOfVideo.get(v.id).title) : "—"])), "");
    } else {
      L.push(callout("info", "Описи канала нет", "Её снимает команда `npm run yt -- --channel`: подписчики, ролики, просмотры."), "");
    }
    if (ytSeries.length) L.push("## Серии", "", table(["Серия", "Порядок", "Роликов", "Просмотров", "Плейлист"], ytSeries.map((s) => [cellLink(seriesPath(s), s.title || s.key), s.order === "parts" ? "по частям" : "по просмотрам", (s.videos || []).length, num(sumViews(s)), s.playlistId ? "создан" : "ещё нет"])), "");
    if (ours.length) L.push("## Ролики завода", "", table(["Когда", "Статус", "Что"], ours.sort((a, b) => dueAt(b) - dueAt(a)).slice(0, 30).map((e) => [`${e.date} ${e.time}`, STATUS_TITLE[e.status] || e.status, cellLink(pubPath(e), preview(e, 60))])), "");
    L.push(`_${AUTO}_`);
    put("YouTube/Канал.md", L.join("\n"));

    for (const s of ytSeries) {
      const vids = s.videos || [];
      const mine = ours.filter((e) => e.series === s.key);
      const S = [frontmatter({ type: "серия", key: s.key, order: s.order === "parts" ? "по частям" : "по просмотрам", videos: vids.length, views: sumViews(s), playlist: s.playlistId ? `https://www.youtube.com/playlist?list=${s.playlistId}` : undefined, tags: ["youtube", "серия"] }), `# ${s.title || s.key}`, "", s.description || "", ""];
      if (s.why) S.push(callout("quote", "Почему эта серия есть", s.why), "");
      S.push(s.playlistId ? `Плейлист: https://www.youtube.com/playlist?list=${s.playlistId}` : `Плейлист ещё не создан: \`npm run yt -- --series-create --series=${s.key}\`.`, "");
      S.push(s.order === "parts" ? "История по частям: порядок задаёт сюжет, в описании каждой части стоят ссылки на предыдущую и следующую." : "Самостоятельные ролики одной темы: первым стоит самый просматриваемый, в описании каждого ссылки на два соседних.", "");
      S.push("## Ролики", "", vids.length ? table(["№", "Просмотры", "Дата", "Длина, с", "Ролик"], vids.map((v, i) => { const full = videoById.get(v.id) || {}; return [i + 1, num(full.views ?? v.views), full.date || "", Number.isFinite(full.seconds) ? full.seconds : "", ext(v.title || full.title || v.id, watch(v.id))]; })) : "Серия заведена под новые ролики: на канале в ней пока пусто.", "");
      if (mine.length) S.push("## В очереди завода", "", table(["Когда", "Статус", "Что"], mine.sort((a, b) => dueAt(a) - dueAt(b)).map((e) => [`${e.date} ${e.time}`, STATUS_TITLE[e.status] || e.status, cellLink(pubPath(e), preview(e, 60))])), "");
      S.push(`Канал: ${link("YouTube/Канал", "опись канала")} · узел: ${link(P.node("video"), "Ролики и YouTube")}.`, "", `_${AUTO}_`);
      put(`${seriesPath(s)}.md`, S.join("\n"));
    }
  }

  /* ── Бот: кодовые слова, материалы, воронка ── */
  const f = input.funnel;
  const botMaterialByKey = new Map((input.materials || []).map((m) => [String(m.key), m]));
  for (const s of input.scenarios || []) {
    const key = String(s["ключ"] || s.key || "");
    const mat = botMaterialByKey.get(key);
    const hits = f?.keywords?.byScenario?.[key] || 0;
    const L = [frontmatter({ type: "кодовое слово", hits, tags: ["бот", "кодовое-слово"] }), `# ${key.toUpperCase()}`, "", `Слова: ${(s["слова"] || []).map((w) => `**${w}**`).join(", ")}. Где слушаем: ${(s["где"] || ["комментарий", "директ"]).join(", ")}.`, "", `Сработало за ${f?.days || 60} дней: **${hits}**.`, "", "## Что уходит человеку в личные сообщения", "", String(s["текст"] || "").split("\n").map((l) => `> ${l}`).join("\n"), ""];
    if (s["публично"]) L.push("## Что видно под комментарием", "", `> ${s["публично"]}`, "");
    if (s["зачем"]) L.push("## Зачем это слово", "", s["зачем"], "");
    if (mat) L.push(`Материал в боте: ${link(P.botMaterial(mat), mat.title || mat.key)}.`, "");
    L.push(`Площадка: ${channels.instagram ? link(P.channel("instagram"), chanTitle("instagram")) : "Instagram"} · узел: ${link(P.node("bot"), "Бот для людей")}.`, "", `_${AUTO}_`);
    put(`${P.scenario(s)}.md`, L.join("\n"));
  }
  for (const m of input.materials || []) {
    const sc = (input.scenarios || []).find((s) => String(s["ключ"] || s.key) === String(m.key));
    const L = [frontmatter({ type: "материал бота", key: m.key, url: m.articleUrl, tags: ["бот", "материал-бота"] }), `# ${m.title || m.key}`, "", m.teaser || "", "", (m.summary || []).map((x) => `- ${x}`).join("\n"), "", m.articleUrl ? `Ведёт на: ${m.articleUrl}` : "", "", `Ссылки с метками: \`?start=<площадка>-${m.key}\` (площадки: ig, vk, th, yt, rt, dz, tg, site).`, ""];
    if (sc) L.push(`Кодовое слово: ${link(P.scenario(sc), String(sc["ключ"]).toUpperCase())}.`, "");
    const article = String(m.articleUrl || "").match(/\/blog\/([^/?#]+)/)?.[1];
    if (article && articleBySlug.has(article)) L.push(`Статья сайта: ${link(P.article(article), articleBySlug.get(article).title || article)}.`, "");
    L.push(`Узел: ${link(P.node("bot"), "Бот для людей")}.`, "", `_${AUTO}_`);
    put(`${P.botMaterial(m)}.md`, L.join("\n"));
  }
  {
    const L = [frontmatter({ type: "сводка", tags: ["бот", "заявки"] }), "# Воронка: от поста до заявки", "", `Узлы: ${link(P.node("bot"), "Бот для людей")} · ${link(P.node("leads"), "Заявки")}. Здесь только счёт: имён и телефонов в витрине нет.`, ""];
    if (!f) L.push(callout("info", "Живых данных нет", "Снимок с сервера ещё не снят: `npm run mirror`."));
    else {
      const steps = [["Переходов по нашим ссылкам", f.clicks.total], ["Пришли в бота", f.bot.entered], ["Получили материал", f.bot.gotMaterial], ["Начали заявку", f.bot.startedLead], ["Оставили заявку в боте", f.bot.leftLead], ["Заявок всего (бот и формы)", f.leads.total]];
      const max = Math.max(1, ...steps.map((s) => s[1]));
      L.push(`За ${f.days} дней:`, "", table(["Шаг", "Людей", ""], steps.map(([t, v]) => [t, num(v), bar(v, max, 22)])), "");
      L.push("```mermaid", "flowchart LR", `    A["Пост или ролик"] --> B["Ссылка /go<br/>${f.clicks.total}"]`, `    A --> C["Кодовое слово<br/>${Object.values(f.keywords.byScenario || {}).reduce((a, b) => a + b, 0)}"]`, `    B --> D["Сайт клиента"]`, `    C --> E["Бот<br/>${f.bot.entered}"]`, `    B --> E`, `    E --> F["Материал<br/>${f.bot.gotMaterial}"]`, `    F --> G["Заявка<br/>${f.leads.total}"]`, `    D --> G`, `    G --> H["Карточка в группе"]`, "```", "");
      const tab = (title, obj, name) => { const rows = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]); if (rows.length) L.push(`## ${title}`, "", table([name, "Сколько", ""], rows.slice(0, 15).map(([k, v]) => [k, v, bar(v, rows[0][1], 16)])), ""); };
      tab("Заявки по площадкам", f.leads.bySource, "Площадка");
      tab("Что просят", f.leads.byNeed, "Потребность");
      tab("Что стало с заявками", Object.fromEntries(Object.entries(f.leads.byStatus || {}).map(([k, v]) => [{ new: "ждёт ответа", taken: "взята в работу", rejected: "не целевая" }[k] || k, v])), "Состояние");
      tab("Входы в бота по меткам", f.bot.byEntry, "Метка");
      tab("Переходы по ссылкам", f.clicks.bySlug, "Ссылка");
      tab("Кодовые слова", f.keywords.byScenario, "Слово");
      L.push(`Остановили бота: ${f.bot.stopped}. Согласились на рассылку: ${f.bot.adsConsent}.`, "");
    }
    L.push(`_${AUTO}_`);
    put("Бот/Воронка.md", L.join("\n"));
  }

  /* ── Отчёты ── */
  for (const r of input.reports || []) put(`${P.report(r.week)}.md`, `${frontmatter({ type: "отчёт", week: r.week, tags: ["отчёт"] })}${r.md.replace(/^# .*$/m, `# Неделя с ${r.week}`)}\n\nУзел: ${link(P.node("metrics"), "Цифры и отчёты")}.\n\n_${AUTO}_`);

  /* ── Канвы ── */
  {
    const c = canvas();
    const colW = 340;
    const gapX = 120;
    const x = (i) => i * (colW + gapX);
    const H = 130;
    const col = (i, title, color, items) => {
      const ys = column(items.length, 80, H, 26);
      c.group(title, x(i) - 30, 0, colW + 60, 80 + items.length * (H + 26) + 20, color);
      return items.map((it, k) => (it.file && files.has(`${it.file}.md`) ? c.file(`${it.file}.md`, x(i), ys[k], { width: colW, height: H, color }) : c.text(it.text || it.file, x(i), ys[k], { width: colW, height: H, color })));
    };
    const sources = col(0, "Откуда берутся темы", "5", [{ text: `**Статьи сайта клиента**\nв проекте: ${(input.articles || []).length}` }, { file: P.node("news") }, { file: P.node("trends") }, { file: "Новости/Вопросы людей" }, { file: "Новости/Комментарии" }, ...(hasYoutube ? [{ file: "YouTube/Канал" }] : [])]);
    const sess = col(1, "Сессии Codex", "6", sessions.filter((s) => ["S1", "S2", "S3", "S4"].includes(s.id)).map((s) => ({ file: P.session(s) })));
    const pipe = col(2, "Очередь", "4", [{ file: P.node("gates") }, { file: P.node("approval") }, { file: P.node("queue") }]);
    const chans = col(3, "Площадки", "2", channelNames.map((n) => ({ file: P.channel(n) })));
    const people = col(4, "Люди и заявки", "1", [{ file: P.node("bot") }, { file: "Бот/Воронка" }, { file: P.node("leads") }, { file: P.node("group") }]);
    const back = col(5, "Обратная связь", "3", [{ file: P.node("metrics") }, { file: P.node("tokens") }, { file: P.node("operator") }]);
    for (const s of sources) for (const t of sess.slice(0, 2)) c.edge(s, t);
    if (sess[3]) { c.edge(sources[1], sess[3]); c.edge(sources[2], sess[3]); }
    for (const s of sess) c.edge(s, pipe[0], { label: "черновик" });
    c.edge(pipe[0], pipe[1], { fromSide: "bottom", toSide: "top", label: "прошло проверки" });
    c.edge(pipe[1], pipe[2], { fromSide: "bottom", toSide: "top", label: "«Одобрить»" });
    for (const ch of chans) c.edge(pipe[2], ch);
    for (const ch of chans) c.edge(ch, people[0]);
    c.edge(people[0], people[1], { fromSide: "bottom", toSide: "top" });
    c.edge(people[1], people[2], { fromSide: "bottom", toSide: "top", label: "заявка" });
    c.edge(people[2], people[3], { fromSide: "bottom", toSide: "top", label: "карточка" });
    for (const ch of chans.slice(0, 2)) c.edge(ch, back[0], { color: "3" });
    c.edge(people[2], back[0], { color: "3" });
    files.set("01 Карта завода.canvas", c.json());
  }
  {
    // Путь одного материала: берём тот, что разошёлся шире всех.
    const ranked = [...materialUse.entries()].sort((a, b) => b[1].length - a[1].length);
    const c = canvas();
    if (ranked.length) {
      const [matPath, used] = ranked[0];
      const src = c.file(`${matPath}.md`, 0, 200, { width: 380, height: 260, color: "5" });
      const list = used.slice(0, 8);
      const ys = column(list.length, 0, 150, 30);
      list.forEach((e, i) => {
        const pub = c.file(`${pubPath(e)}.md`, 520, ys[i], { width: 400, height: 150, color: e.status === "published" ? "4" : "3" });
        c.edge(src, pub, { label: chanTitle(e.channel) });
        const chNode = c.file(`${P.channel(e.channel)}.md`, 1040, ys[i], { width: 300, height: 150, color: "2" });
        c.edge(pub, chNode);
      });
      const fun = c.file("Бот/Воронка.md", 1460, 200, { width: 360, height: 260, color: "1" });
      c.text("Один материал, несколько форматов. Слева источник, в середине то, что из него сделано, справа то, ради чего всё это.", 0, -140, { width: 760, height: 100 });
      c.edge(src, fun, { fromSide: "bottom", toSide: "bottom", label: "ссылка с меткой", color: "1" });
    } else {
      c.text("Путь материала появится после первой постановки в очередь.", 0, 0, { width: 420, height: 100 });
    }
    files.set("02 Путь материала.canvas", c.json());
  }

  /* ── Таблицы-базы Obsidian (Bases): живые таблицы поверх свойств заметок ── */
  const base = (folder, columns, extra = "") => `filters:\n  and:\n    - file.inFolder("${folder}")\nproperties:\n${Object.entries(columns).map(([k, v]) => `  ${k}:\n    displayName: ${JSON.stringify(v)}`).join("\n")}\nviews:\n  - type: table\n    name: "Все"\n    order:\n      - file.name\n${Object.keys(columns).map((k) => `      - ${k}`).join("\n")}\n${extra}`;
  files.set("Таблицы/Публикации.base", base("Публикации", { status: "Статус", channel: "Площадка", date: "Дата", time: "Время", material: "Материал", views: "Просмотры" }, `  - type: table\n    name: "По статусам"\n    groupBy:\n      property: status\n      direction: ASC\n    order:\n      - file.name\n      - channel\n      - date\n      - time\n      - views\n  - type: table\n    name: "По площадкам"\n    groupBy:\n      property: channel\n      direction: ASC\n    order:\n      - file.name\n      - status\n      - date\n      - views\n`));
  files.set("Таблицы/Материалы.base", base("Материалы", { kind: "Вид", used: "Сделано публикаций", published: "Опубликована", words: "Слов" }));
  files.set("Таблицы/Ключи.base", base("Ключи", { secret: "Секрет", where: "Где живёт", days_left: "Осталось дней" }));

  /* ── Главная ── */
  {
    const counts = STATUSES.map((s) => [STATUS_TITLE[s], queue.filter((e) => e.status === s).length]).filter(([, v]) => v);
    const weekPublished = queue.filter((e) => e.status === "published" && now - dueAt(e) < 7 * 86_400_000).length;
    const upcoming = queue.filter((e) => ["approved", "review"].includes(e.status) && dueAt(e) > now).sort((a, b) => dueAt(a) - dueAt(b)).slice(0, 10);
    const L = [frontmatter({ type: "главная", built: new Date(now).toISOString(), tags: ["завод"] }), `# Контент-завод · ${cfg.client?.name || ""}`, ""];
    L.push(input.live ? `Снимок с сервера: ${String(input.state?.pulledAt || "").slice(0, 16).replace("T", " ")} UTC. Собрано ${mskDate(now)} в ${mskTime(now)} по Москве.` : callout("info", "Живых данных пока нет", "Витрина собрана из проекта: площадки, код, промпты, документы. Очередь, цифры и воронка появятся после `npm run mirror`."), "");
    if (input.state?.stopped) L.push(callout("danger", "Выпуск остановлен", "На сервере лежит файл STOP. Включает команда /start_release в рабочей группе."), "");
    if (input.state?.held) L.push(callout("warning", "Выпуск ждёт кнопки", "Сервер вернулся после простоя и ждёт подтверждения в рабочей группе."), "");
    L.push("## Сейчас", "", table(["Что", "Сколько"], [["Вышло за семь дней", weekPublished], ...counts, ["Заявок за 60 дней", f ? f.leads.total : "—"], ["Статей сайта в работе", `${[...materialUse.keys()].filter((p) => p.startsWith("Материалы/Статьи/")).length} из ${(input.articles || []).length}`]]), "");
    if (upcoming.length) L.push("## Ближайшие выходы", "", table(["Когда", "Площадка", "Статус", "Что"], upcoming.map((e) => [`${e.date.slice(8)}.${e.date.slice(5, 7)} ${e.time}`, cellLink(P.channel(e.channel), chanTitle(e.channel)), STATUS_TITLE[e.status], cellLink(pubPath(e), preview(e, 56))])), "");
    L.push("## Карты", "", `- [[01 Карта завода.canvas|Карта завода]]: откуда берутся темы и как они доходят до заявки`, `- [[02 Путь материала.canvas|Путь материала]]: одна статья, несколько форматов`, dayList.includes(today) ? `- ${link(P.day(today), "Расписание на сегодня")}` : "", `- ${link("Бот/Воронка", "Воронка: от поста до заявки")}`, hasYoutube ? `- ${link("YouTube/Канал", "YouTube: опись канала и серии")}` : "", `- ${link("Новости/Комментарии", "Комментарии, которые ждут ответа")}`, "");
    L.push("## Из чего состоит завод", "", table(["Узел", "Что делает"], NODES.map((n) => [cellLink(P.node(n.key), n.title), n.what])), "");
    L.push("## Площадки", "", table(["Площадка", "Реклама", "Слоты", "Вышло", "Сессия"], channelNames.map((n) => [cellLink(P.channel(n), chanTitle(n)), channels[n].access === "restricted" ? "нельзя" : "можно", (channels[n].slots || []).join(", "), queue.filter((e) => e.channel === n && e.status === "published").length, sessionOf(n) ? cellLink(P.session(sessionOf(n)), sessionOf(n).id) : "—"])), "");
    L.push("## Сессии Codex", "", sessions.map((s) => `- ${link(P.session(s), `${s.id}. ${s.title}`)}: ${s.what}`).join("\n"), "");
    L.push("## Правила, которые нельзя обойти", "", RULES.map((r) => `- ${link(P.rule(r.key), r.key)}: ${r.what}`).join("\n"), `- ${link("Правила/Статусы записи")}: без «Одобрить» от клиента не выходит ничего`, "");
    L.push("## Люди", "", ROLES.map((r) => `- ${link(P.role(r), r.title)}: ${r.who}`).join("\n"), "");
    if (lessons.length || risks.length) L.push("## Опыт и риски", "", `Граблей записано: ${lessons.length}. Рисков на контроле: ${risks.length}.`, "", ...lessons.slice(0, 8).map((l) => `- ${link(lessonPath(l), l.title)}`), "");
    const master = (input.prompts || []).find((p) => /МАСТЕР/i.test(p.path));
    L.push("## Документы", "", [master ? `- ${link(P.prompt(master), "Мастер-промпт")}` : "", ...(input.docs || []).map((d) => `- ${link(P.doc(d), d.title)}`), ...(input.legal || []).map((d) => `- ${link(P.doc(d), d.title)}`)].filter(Boolean).join("\n"), "");
    L.push("## Как показывать", "", "1. Открыть граф (Ctrl+G). Цвета: синие площадки, зелёные публикации, жёлтые материалы, серый код, красные ключи, алый YouTube.", "2. Открыть карту завода: от статьи сайта слева до заявки справа.", "3. Открыть любую публикацию: текст, кто согласовал, проверки, цифры, из какого материала сделана.", "4. Открыть «Таблицы/Публикации» и переключить вид «По статусам».", "", `_${AUTO}_`);
    put(`${P.home}.md`, L.filter((x) => x !== undefined).join("\n"));
  }

  return files;
}

/** Настройки Obsidian: цвета графа и типы свойств. Создаются, только если их ещё нет. */
export function obsidianConfig() {
  const rgb = (hex) => parseInt(hex, 16);
  const groups = [["Площадки", "3B82F6"], ["Публикации", "22C55E"], ["Материалы", "F59E0B"], ["Сессии", "A855F7"], ["Промпты", "C084FC"], ["Код", "64748B"], ["Ключи", "EF4444"], ["Бот", "06B6D4"], ["Правила", "EAB308"], ["Грабли", "F97316"], ["Риски", "FB7185"], ["Расписание", "84CC16"], ["Расписания", "10B981"], ["Узлы", "FFFFFF"], ["Новости", "14B8A6"], ["Отчёты", "38BDF8"], ["Документы", "94A3B8"], ["Люди", "F472B6"], ["YouTube", "FF0033"]];
  return {
    "graph.json": JSON.stringify({ "collapse-filter": false, search: "", showTags: false, showAttachments: false, hideUnresolved: true, showOrphans: false, "collapse-color-groups": false, colorGroups: groups.map(([p, hex]) => ({ query: `path:"${p}/"`, color: { a: 1, rgb: rgb(hex) } })), "collapse-display": false, showArrow: true, textFadeMultiplier: 0, nodeSizeMultiplier: 1.15, lineSizeMultiplier: 1, "collapse-forces": false, centerStrength: 0.45, repelStrength: 12, linkStrength: 1, linkDistance: 220, scale: 0.35, close: false }, null, 2),
    "types.json": JSON.stringify({ types: { aliases: "aliases", cssclasses: "multitext", tags: "tags", date: "date", views: "number", used: "number", words: "number", lines: "number", days_left: "number", per_day: "number", published: "text", secret: "checkbox", built: "datetime" } }, null, 2),
    "app.json": JSON.stringify({ alwaysUpdateLinks: true, newLinkFormat: "absolute", useMarkdownLinks: false, showUnsupportedFiles: false }, null, 2),
  };
}

/** Запись на диск с уборкой своих прошлых файлов. */
export function writeVault(files, dir) {
  mkdirSync(dir, { recursive: true });
  const manifestFile = path.join(dir, ".zavod-manifest.json");
  const before = readJson(manifestFile, { files: [] })?.files || [];
  const now = new Set(files.keys());
  let removed = 0;
  for (const old of before) {
    if (now.has(old)) continue;
    const p = path.join(dir, old);
    if (existsSync(p)) { rmSync(p); removed++; }
  }
  let written = 0;
  for (const [relPath, text] of files) {
    const p = path.join(dir, relPath);
    mkdirSync(path.dirname(p), { recursive: true });
    if (existsSync(p) && readFileSync(p, "utf8") === text) continue; // не трогаем неизменное: Obsidian не перечитывает лишнего
    writeFileSync(p, text, "utf8");
    written++;
  }
  const cfgDir = path.join(dir, ".obsidian");
  mkdirSync(cfgDir, { recursive: true });
  for (const [name, text] of Object.entries(obsidianConfig())) if (!existsSync(path.join(cfgDir, name))) writeFileSync(path.join(cfgDir, name), text, "utf8");
  writeFileSync(manifestFile, JSON.stringify({ built: new Date().toISOString(), files: [...now].sort() }, null, 1), "utf8");
  return { written, removed, total: files.size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const input = gather();
    const files = buildVault(input);
    const dangling = danglingLinks(files);
    let links = 0;
    for (const [p, text] of files) if (p.endsWith(".md")) links += linksIn(text).length;
    const dir = path.resolve(env("VAULT_DIR", path.join(PROJECT_ROOT, "vault")));
    if (process.argv.includes("--check")) {
      console.log(`заметок ${files.size}, связей ${links}, висячих ссылок ${dangling.length}${input.live ? "" : " (без снимка с сервера)"}`);
    } else {
      const r = writeVault(files, dir);
      console.log(`${new Date().toISOString()} витрина: ${dir}\nзаметок ${r.total}, записано ${r.written}, убрано ${r.removed}, связей ${links}, висячих ссылок ${dangling.length}${input.live ? "" : "\nснимка с сервера нет: живые данные появятся после npm run mirror"}`);
    }
    for (const d of dangling.slice(0, 15)) console.error(`  висячая ссылка: ${d.file} → ${d.target}`);
    if (dangling.length) process.exitCode = 1;
  } catch (e) {
    console.error(`сбой сборки витрины: ${e?.stack || e}`);
    process.exitCode = 2;
  }
}
