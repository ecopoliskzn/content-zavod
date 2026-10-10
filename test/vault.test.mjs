// Витрина Obsidian: заметки собираются из состояния завода, ссылки никуда не ведут в пустоту.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "zavod-vault-data-"));
process.env.ZAVOD_ENV_FILE = path.join(process.env.DATA_DIR, "нет-такого.env");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = await import("../src/vault/lib.mjs");
const { buildVault, gather, moduleHeader, moduleLinks, obsidianConfig, parseSections, writeVault } = await import("../src/vault/build.mjs");
const { publicComments } = await import("../src/queue/snapshot.mjs");

test("имя заметки: без знаков, которые ломают Windows и ссылки Obsidian", () => {
  assert.equal(lib.safe('Прораб: "щука" / как? #1 [черновик]'), "Прораб щука как 1 черновик");
  assert.equal(lib.safe("точка в конце..."), "точка в конце");
  assert.equal(lib.safe(""), "без имени");
  assert.equal(lib.safe("а".repeat(200)).length, 90);
});

test("ссылка идёт по полному пути, в ячейке таблицы черта экранирована", () => {
  assert.equal(lib.link("Площадки/YouTube"), "[[Площадки/YouTube|YouTube]]");
  assert.equal(lib.link("Площадки/YouTube.md", "канал [главный] | видео"), "[[Площадки/YouTube|канал  главный    видео]]");
  assert.equal(lib.cellLink("Площадки/YouTube", "YouTube"), "[[Площадки/YouTube\\|YouTube]]");
  assert.deepEqual(lib.linksIn("см. [[Узлы/Очередь|очередь]], [[Бот/Воронка\\|воронка]] и [[Правила/Статусы записи#схема]]"), ["Узлы/Очередь", "Бот/Воронка", "Правила/Статусы записи"]);
});

test("шапка свойств, таблица, полоска и число", () => {
  assert.equal(lib.frontmatter({ type: "день", posts: 3, ok: true, tags: ["а", "б"], empty: "", none: undefined, list: [] }), '---\ntype: "день"\nposts: 3\nok: true\ntags: ["а", "б"]\n---\n');
  assert.equal(lib.table(["А", "Б"], []), "_пусто_");
  assert.equal(lib.table(["А", "Б"], [["x|y", "строка\nвторая"]]), "| А | Б |\n|---|---|\n| x\\|y | строка вторая |");
  assert.equal(lib.bar(5, 10, 10), "█████░░░░░");
  assert.equal(lib.bar(50, 10, 4), "████");
  assert.equal(lib.bar(NaN, 10), "");
  assert.equal(lib.num(84255), "84 255");
  assert.equal(lib.num(undefined), "—");
  assert.equal(lib.tag("Ждёт согласования!"), "ждёт-согласования");
});

test("висячая ссылка находится, ссылка на канву и таблицу висячей не считается", () => {
  const files = new Map([["А.md", "[[Б|б]] [[Нет/Такой]] [[01 Карта.canvas|карта]] [[Таблицы/Публикации.base]]"], ["Б.md", "текст"], ["01 Карта.canvas", "{}"], ["Таблицы/Публикации.base", ""]]);
  assert.deepEqual(lib.danglingLinks(files), [{ file: "А.md", target: "Нет/Такой" }]);
});

test("канва: у узлов свои номера, связи ведут к существующим узлам, группы лежат под ними", () => {
  const c = lib.canvas();
  const a = c.file("А.md", 0, 0);
  const b = c.text("текст", 400, 0, { color: "3" });
  c.group("Группа", -20, -20, 800, 200, "5");
  c.edge(a, b, { label: "ведёт" });
  const data = JSON.parse(c.json());
  assert.equal(data.nodes[0].type, "group");
  assert.equal(new Set(data.nodes.map((n) => n.id)).size, 3);
  assert.deepEqual(data.edges.map((e) => [e.fromNode, e.toNode, e.label]), [[a, b, "ведёт"]]);
  assert.deepEqual(lib.column(3, 80, 100, 20), [80, 200, 320]);
});

test("шапка модуля читается и после строки запуска, связи и ключи находятся", () => {
  const source = '#!/usr/bin/env node\n// Выпуск по расписанию.\n//\n// Раз в пять минут.\n\nimport { env } from "../lib/env.mjs";\nimport * as store from "./store.mjs";\nconst { x } = await import("#bot");\nconst t = env("THREADS_TOKEN"); if (has("TG_GROUP_ID")) num("PORT", 3100);\n';
  assert.equal(moduleHeader(source), "Выпуск по расписанию.\n\nРаз в пять минут.");
  assert.equal(moduleHeader("/**\n * Блочная шапка.\n * Вторая строка.\n */\nconst a = 1;"), "Блочная шапка.\nВторая строка.");
  assert.equal(moduleHeader("const a = 1;"), "");
  const { imports, envNames } = moduleLinks(source, path.join(ROOT, "src", "queue", "runner.mjs"), ROOT);
  assert.deepEqual(imports.sort(), ["packages/bot/src/index.mjs", "src/lib/env.mjs", "src/queue/store.mjs"]);
  assert.deepEqual(envNames.sort(), ["PORT", "TG_GROUP_ID", "THREADS_TOKEN"]);
});

test("грабли и риски разбираются на разделы с полями", () => {
  const s = parseSections("# Грабли\n\n## Threads\n\n### Параметры уходят формой\nГде: threads, queue\nОткуда: наш запуск\n\nТело раздела.\nВторая строка.\n\n### Без полей\nСразу текст: с двоеточием внутри.\n\n## Бот\n\n### Вебхук отвечает 200\nГде: bot\n\nВсегда.");
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], { title: "Параметры уходят формой", area: "Threads", fields: { "где": "threads, queue", "откуда": "наш запуск" }, body: "Тело раздела.\nВторая строка." });
  assert.equal(s[2].area, "Бот");
  assert.deepEqual(s[2].fields, { "где": "bot" });
});

const emptyMirror = mkdtempSync(path.join(os.tmpdir(), "zavod-vault-empty-"));
const base = gather(ROOT, emptyMirror);

/** Все файлы, на которые ссылаются узлы канвы, существуют в наборе. */
function assertCanvas(files, name) {
  const data = JSON.parse(files.get(name));
  const ids = new Set(data.nodes.map((n) => n.id));
  assert.ok(data.nodes.length > 0, `${name}: канва пуста`);
  for (const n of data.nodes.filter((x) => x.type === "file")) assert.ok(files.has(n.file), `${name}: узел ведёт на несуществующую заметку ${n.file}`);
  for (const e of data.edges) assert.ok(ids.has(e.fromNode) && ids.has(e.toNode), `${name}: связь ведёт к несуществующему узлу`);
  return data;
}

test("витрина из проекта без снимка: всё связано, живых данных нет и об этом сказано", () => {
  const files = buildVault(base);
  assert.deepEqual(lib.danglingLinks(files), []);
  assert.ok(files.size > 300, `заметок слишком мало: ${files.size}`);
  const home = files.get("00 Завод.md");
  assert.match(home, /Живых данных пока нет/);
  assert.match(home, /# Контент-завод · /);
  for (const name of Object.keys(base.config.channels)) assert.ok(files.has(`Площадки/${lib.safe(base.config.channels[name].title)}.md`), `нет заметки площадки ${name}`);
  for (const s of base.config.sessions) assert.ok(files.has(`Сессии/${lib.safe(`${s.id} ${s.title}`)}.md`), `нет заметки сессии ${s.id}`);
  assert.ok(files.has("Код/src/queue/runner.mjs.md"));
  assert.ok(files.has("Ключи/THREADS_TOKEN.md"));
  assert.ok(files.has("Правила/Проверка «Ролик».md"));
  assert.ok(files.has("Правила/Статусы записи.md"));
  assert.ok(files.has("Узлы/Ролики и YouTube.md"));
  assert.ok(files.has("Узлы/Комментарии.md"));
  assertCanvas(files, "01 Карта завода.canvas");
  assertCanvas(files, "02 Путь материала.canvas");
  assert.match(files.get("Таблицы/Публикации.base"), /file\.inFolder\("Публикации"\)/);
});

test("YouTube в витрине: опись канала, серии и ссылки на них с площадки", () => {
  const files = buildVault(base);
  const channel = files.get("YouTube/Канал.md");
  assert.ok(channel, "заметки канала нет");
  assert.match(channel, /Подписчиков/);
  assert.match(channel, /## По годам/);
  assert.match(channel, /## Что уже заходило/);
  assert.match(channel, /## Серии/);
  const series = [...files.keys()].filter((p) => p.startsWith("YouTube/Серии/"));
  assert.equal(series.length, base.youtubeSeries.length);
  assert.match(files.get(series[0]), /Плейлист ещё не создан: `npm run yt -- --series-create --series=/);
  const platform = files.get(`Площадки/${lib.safe(base.config.channels.youtube.title)}.md`);
  assert.match(platform, /\[\[YouTube\/Канал\|Опись канала\]\]/);
  assert.match(files.get("Узлы/Ролики и YouTube.md"), /src\/video\/series\.mjs/);
});

test("ключи в витрине: значения не появляются нигде, только имена", () => {
  const files = buildVault(base);
  const note = files.get("Ключи/TG_BOT_TOKEN.md");
  assert.match(note, /значение не печатается/);
  assert.match(note, /релей/);
  const all = [...files.values()].join("\n");
  assert.doesNotMatch(all, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, "похоже на токен бота Telegram");
});

const NOW = Date.parse("2026-10-12T09:00:00+03:00");
const SLUG = "kak-proverit-kachestvo-rezinovogo-pokrytiya-posle-ukladki-chek-list-dlya-zakazchika-chast-1";
const ARTICLE = `Материалы/Статьи/${lib.safe(SLUG)}`;
const entry = (over) => {
  const e = { id: over.name, channel: "threads", kind: "thread", status: "published", date: "2026-10-09", time: "19:00", material: `blog:${SLUG}`, ...over };
  // Реплики есть только у ветки: у поста и ролика свой текст.
  return e.kind === "thread" ? { posts: ["Площадку во дворе приняли за пять минут.", "Толщину никто не мерил."], ...e } : e;
};
const live = {
  ...base,
  now: NOW,
  live: true,
  state: { pulledAt: "2026-10-12T05:45:00.000Z", stopped: false, held: true },
  queue: [
    entry({ name: "vetka-priemka", approval: { name: "Анна", at: "2026-10-08T10:00:00.000Z" }, result: { link: "https://www.threads.net/@eco/post/1" } }),
    entry({ name: "rolik-priemka", channel: "youtube", kind: "video", status: "approved", date: "2026-10-13", time: "10:00", title: "Прораб положил покрытие в дождь", text: "Что стало с площадкой через зиму.", series: base.youtubeSeries[0]?.key, media: [{ type: "video", url: "https://storage.example.ru/v.mp4" }] }),
    entry({ name: "post-novost", channel: "telegram", kind: "post", status: "review", date: "2026-10-12", time: "12:00", material: "news:n1", text: "В Казани восстановят покрытие в парке." }),
    entry({ name: "otvet", channel: "youtube", kind: "reply", status: "published", date: "2026-10-10", time: "11:00", material: "comment:youtube:abc", text: "Толщина зависит от высоты падения.", link: "https://www.youtube.com/watch?v=x&lc=abc" }),
    entry({ name: "snyato", status: "cancelled", date: "2026-10-11" }),
    { id: "", channel: "threads" },
  ],
  ledger: [{ id: "vetka-priemka", status: "published", channel: "threads", link: "https://www.threads.net/@eco/post/1", at: "2026-10-09T16:00:10.000Z" }],
  metrics: [{ id: "vetka-priemka", views: 420, likes: 12, replies: 3, day: "2026-10-11" }],
  metricSeries: [{ id: "vetka-priemka", day: "2026-10-09", views: 150 }, { id: "vetka-priemka", day: "2026-10-10", views: 300 }, { id: "vetka-priemka", day: "2026-10-11", views: 420 }],
  followers: [{ channel: "youtube", count: 1352, day: "2026-10-11" }],
  news: [{ id: "n1", title: "В парке восстановят резиновое покрытие", url: "https://example.ru/n1", status: "taken", source: "rv", sourceTitle: "Реальное время", at: "2026-10-10T08:00:00Z", score: 21, tags: ["ядро"] }],
  trends: [{ ratio: 8.6, source: "youtube", channel: "Чужой канал", title: "Залетевший ролик", url: "https://example.ru/t", published: "2026-10-01T10:00:00Z" }],
  funnel: { days: 60, clicks: { total: 14, bySlug: { priemka: 14 }, byChannel: { yt: 9, th: 5 } }, bot: { entered: 6, gotMaterial: 5, startedLead: 3, leftLead: 2, stopped: 1, adsConsent: 2, byEntry: { "ig-priemka": 4 } }, leads: { total: 3, bySource: { yt: 2, vk: 1 }, byNeed: { "Покрытие для площадки": 3 }, byStatus: { taken: 2, new: 1 } }, keywords: { byScenario: { priemka: 4 }, failed: 0 } },
  questions: [{ day: "2026-10-10", text: "Какая толщина нужна под качели? Мой номер [телефон]" }],
  comments: publicComments([
    { id: "youtube:abc", platform: "youtube", at: "2026-10-10T07:00:00Z", status: "new", link: "https://www.youtube.com/watch?v=x&lc=abc", text: "А какая толщина под качели? Звоните 8 999 111-22-33, Иванов", author: "Иванов И." },
    { id: "youtube:abc", platform: "youtube", at: "2026-10-10T07:00:00Z", status: "answered", link: "https://www.youtube.com/watch?v=x&lc=abc", text: "А какая толщина под качели? Звоните 8 999 111-22-33, Иванов" },
    { id: "vk:1_2", platform: "vk", at: "2026-10-11T07:00:00Z", status: "new", link: "https://vk.com/wall-1_1?reply=2", text: "Сколько сохнет покрытие | перед дождём?" },
  ]),
  tokens: [{ name: "THREADS_TOKEN", set: true, daysLeft: 41, status: "действует, осталось 41 дн." }],
  reports: [{ week: "2026-10-05", md: "# Отчёт\n\n## Заявки\n\nЗаявок 3." }],
};

test("снимок комментариев: последняя запись побеждает, телефон и лишние поля не уезжают", () => {
  assert.equal(live.comments.length, 2);
  const yt = live.comments.find((c) => c.id === "youtube:abc");
  assert.equal(yt.status, "answered");
  assert.equal(yt.text, "А какая толщина под качели? Звоните [телефон], Иванов");
  assert.deepEqual(Object.keys(yt).sort(), ["at", "id", "link", "platform", "post", "status", "text"]);
});

test("витрина со снимком: публикация связана с площадкой, днём, материалом и цифрами", () => {
  const files = buildVault(live);
  assert.deepEqual(lib.danglingLinks(files), []);
  const pub = [...files.keys()].find((p) => p.startsWith("Публикации/") && p.includes("vetka-priemka"));
  const note = files.get(pub);
  assert.match(note, /\[\[Площадки\/Threads\|Threads\]\]/);
  assert.match(note, /\[\[Расписание\/2026-10-09\|09\.10\]\]/);
  assert.ok(note.includes(`[[${ARTICLE}|`), "публикация ссылается на статью сайта");
  assert.match(note, /Вышло: https:\/\/www\.threads\.net\/@eco\/post\/1/);
  assert.match(note, /Согласовано\n> Анна, 2026-10-08 10:00 UTC/);
  assert.match(note, /\| Просмотры \| 420/);
  assert.match(note, /Как набирались просмотры/);
  assert.match(note, /\*\*1\.\*\* Площадку во дворе приняли за пять минут\./);
  // Статья помнит, что из неё сделано.
  const article = files.get(`${ARTICLE}.md`);
  assert.match(article, /## Что из неё сделано \(3\)/, "ветка, ролик и снятая запись: история статьи полная");
  // День расписания собран, снятая запись в него не попала.
  assert.ok(files.has("Расписание/2026-10-09.md"));
  assert.ok(!files.has("Расписание/2026-10-11.md"));
  // Запись без номера и площадки в витрину не идёт и сборку не роняет.
  assert.equal([...files.keys()].filter((p) => p.startsWith("Публикации/")).length, 5);
});

test("витрина со снимком: главная, воронка, новости, комментарии, отчёт, ролик в серии", () => {
  const files = buildVault(live);
  const home = files.get("00 Завод.md");
  assert.match(home, /Снимок с сервера: 2026-10-12 05:45 UTC/);
  assert.match(home, /Выпуск ждёт кнопки/);
  assert.match(home, /\| Заявок за 60 дней \| 3 \|/);
  assert.match(home, /## Ближайшие выходы/);
  const funnel = files.get("Бот/Воронка.md");
  assert.match(funnel, /\| Переходов по нашим ссылкам \| 14 \|/);
  assert.match(funnel, /flowchart LR/);
  assert.match(funnel, /## Заявки по площадкам/);
  const news = files.get("Новости/Ящик новостей.md");
  assert.match(news, /## Взяты в работу/);
  assert.ok(files.has("Материалы/Новости/n1.md"));
  assert.match(files.get("Материалы/Новости/n1.md"), /# В парке восстановят резиновое покрытие/);
  assert.match(files.get("Новости/Что зашло у других.md"), /8,6×/);
  const comments = files.get("Новости/Комментарии.md");
  assert.match(comments, /\| ждут ответа \| 1 \|/);
  assert.match(comments, /\| ответили \| 1 \|/);
  assert.ok(comments.includes("| [Сколько сохнет покрытие перед дождём?](https://vk.com/wall-1_1?reply=2) |\n"), "черта из текста комментария таблицу не ломает");
  // Ответ на комментарий связан с самим комментарием.
  const stub = files.get("Материалы/Комментарии/youtube abc.md");
  assert.ok(stub, "заметки комментария нет");
  assert.match(stub, /Звоните \[телефон\]/);
  assert.match(stub, /## Что из этого сделано \(1\)/);
  assert.match(files.get("Отчёты/Неделя с 2026-10-05.md"), /# Неделя с 2026-10-05/);
  const seriesNote = files.get(`YouTube/Серии/${lib.safe(base.youtubeSeries[0].title)}.md`);
  assert.match(seriesNote, /## В очереди завода/);
  assert.match(files.get("YouTube/Канал.md"), /## Ролики завода/);
  assert.match(files.get("Ключи/THREADS_TOKEN.md"), /действует, осталось 41 дн\./);
  const all = [...files.values()].join("\n");
  assert.doesNotMatch(all, /111-22-33|Иванов И\./, "телефона и автора комментария в витрине нет");
  const path2 = assertCanvas(files, "02 Путь материала.canvas");
  assert.ok(path2.nodes.some((n) => n.file === `${ARTICLE}.md`), "путь материала показывает самую разошедшуюся статью");
});

test("запись на диск: неизменное не трогается, своё устаревшее убирается, чужая заметка остаётся", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zavod-vault-out-"));
  const first = writeVault(new Map([["А.md", "один\n"], ["Папка/Б.md", "два\n"]]), dir);
  assert.deepEqual(first, { written: 2, removed: 0, total: 2 });
  assert.ok(existsSync(path.join(dir, ".obsidian", "graph.json")));
  writeFileSync(path.join(dir, "Моя заметка.md"), "написал человек\n");
  writeFileSync(path.join(dir, ".obsidian", "graph.json"), '{"моя":"настройка"}');
  const second = writeVault(new Map([["А.md", "один\n"], ["В.md", "три\n"]]), dir);
  assert.deepEqual(second, { written: 1, removed: 1, total: 2 });
  assert.ok(!existsSync(path.join(dir, "Папка", "Б.md")));
  assert.equal(readFileSync(path.join(dir, "Моя заметка.md"), "utf8"), "написал человек\n");
  assert.equal(readFileSync(path.join(dir, ".obsidian", "graph.json"), "utf8"), '{"моя":"настройка"}', "настройки Obsidian, которые человек поменял, не затираются");
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, ".zavod-manifest.json"), "utf8")).files, ["А.md", "В.md"]);
});

test("настройки Obsidian: цвета графа по папкам, JSON читается", () => {
  const cfg = obsidianConfig();
  const graph = JSON.parse(cfg["graph.json"]);
  assert.ok(graph.colorGroups.some((g) => g.query === 'path:"YouTube/"'));
  assert.ok(graph.colorGroups.every((g) => Number.isInteger(g.color.rgb)));
  assert.equal(JSON.parse(cfg["app.json"]).newLinkFormat, "absolute");
  assert.equal(JSON.parse(cfg["types.json"]).types.views, "number");
});
