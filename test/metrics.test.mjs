// Цифры и сторожа: сводка недели, сроки ключей, срок ответа на заявку, выбросы у конкурентов.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "zavod-metrics-"));
process.env.ZAVOD_ENV_FILE = path.join(process.env.DATA_DIR, "нет-такого.env");

const { lastWeek, latest, median, suggest, summarize } = await import("../src/metrics/summary.mjs");
const { dueToday } = await import("../src/metrics/pull.mjs");
const { markdown, telegramText } = await import("../src/metrics/weekly.mjs");
const { daysLeft } = await import("../src/tokens/check.mjs");
const { REGISTRY, required } = await import("../src/tokens/registry.mjs");
const { overdue, workMinutes } = await import("../src/leads/sla.mjs");
const { digest, outliers, parseYoutubeFeed } = await import("../src/trends/collect.mjs");

const msk = (s) => Date.parse(`${s}+03:00`);
const NOW = msk("2026-10-12T10:00:00"); // понедельник
const W = lastWeek(NOW);

test("медиана не боится пустоты, нечётного и чётного набора", () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 100, 3]), 3);
  assert.equal(median([1, 3, 5, 100]), 4);
  assert.equal(median([1, NaN, 3]), 2);
});

test("прошлая неделя: с понедельника по понедельник по Москве", () => {
  assert.equal(W.label, "2026-10-05");
  assert.equal(W.from, msk("2026-10-05T00:00:00"));
  assert.equal(W.to, msk("2026-10-12T00:00:00"));
});

test("последний удачный замер побеждает, замер с ошибкой цифру не стирает", () => {
  const m = latest([{ id: "a", views: 10 }, { id: "a", views: 50 }, { id: "a", error: "сеть" }]);
  assert.equal(m.get("a").views, 50);
});

const row = (id, channel, at, slot, extra = {}) => ({ at: new Date(msk(at)).toISOString(), id, channel, name: `имя-${id}`, material: extra.material || `blog:${id}`, slot, status: "published", link: `https://example.ru/${id}`, ...extra });

test("сводка недели: заявки сверху, пост сравнивается со своей площадкой", () => {
  const ledger = [
    // история площадки за прошлые недели: обычный пост Threads набирает около ста
    row("h1", "threads", "2026-09-20T19:00:00", "2026-09-20 19:00"),
    row("h2", "threads", "2026-09-21T19:00:00", "2026-09-21 19:00"),
    row("h3", "threads", "2026-09-22T19:00:00", "2026-09-22 19:00"),
    // неделя отчёта
    row("t1", "threads", "2026-10-06T19:00:00", "2026-10-06 19:00", { material: "blog:priemka" }),
    row("t2", "threads", "2026-10-07T14:30:00", "2026-10-07 14:30"),
    row("y1", "youtube", "2026-10-07T10:00:00", "2026-10-07 10:00", { material: "blog:priemka" }),
    row("t1", "threads", "2026-10-06T19:00:05", "2026-10-06 19:00", { material: "blog:priemka" }), // повтор строки журнала
    row("old", "threads", "2026-10-13T19:00:00", "2026-10-13 19:00"), // уже следующая неделя
    { ...row("x", "vk", "2026-10-08T12:00:00", "2026-10-08 12:00"), status: "failed" },
  ];
  const metrics = [{ id: "h1", views: 90 }, { id: "h2", views: 100 }, { id: "h3", views: 110 }, { id: "t1", views: 400 }, { id: "t2", views: 80 }, { id: "y1", views: 2000, watchPct: 55 }];
  const leads = [
    { id: "L1", createdAt: new Date(msk("2026-10-07T12:00:00")).toISOString(), source: "ecopolis:yt", needTitle: "Покрытие для площадки", name: "Иван", phone: "+79990000000" },
    { id: "L2", createdAt: new Date(msk("2026-10-08T12:00:00")).toISOString(), source: "ecopolis:yt", needTitle: "Покрытие для площадки" },
    { id: "L3", createdAt: new Date(msk("2026-10-01T12:00:00")).toISOString(), source: "ecopolis:vk", needTitle: "Другое" },
  ];
  const s = summarize({
    ledger, metrics, leads,
    leadCards: [{ leadId: "L1", status: "taken" }],
    clicks: [{ at: new Date(msk("2026-10-07T11:00:00")).toISOString(), c: "yt", v: "a", device: "mobile" }, { at: new Date(msk("2026-10-07T11:01:00")).toISOString(), c: "yt", v: "a", device: "robot" }],
    keywords: [{ at: new Date(msk("2026-10-07T11:00:00")).toISOString(), scenario: "priemka" }, { at: new Date(msk("2026-10-07T11:00:00")).toISOString(), failed: true }],
    followers: [{ at: new Date(msk("2026-10-05T07:00:00")).toISOString(), channel: "youtube", count: 1330 }, { at: new Date(msk("2026-10-11T07:00:00")).toISOString(), channel: "youtube", count: 1352 }],
    window: W, channelTitles: { threads: "Threads", youtube: "YouTube", vk: "ВКонтакте", yt: "YouTube" }, activeChannels: ["threads", "youtube", "vk"],
  });
  assert.equal(s.posts, 3, "повтор строки журнала и чужая неделя не считаются");
  assert.equal(s.leads.total, 2);
  assert.deepEqual(s.leads.bySource, { yt: 2 });
  assert.equal(s.leads.taken, 1);
  assert.equal(s.leads.unanswered, 1);
  assert.equal(s.clicks.total, 1, "робот превью переходом не считается");
  assert.deepEqual(s.keywords, { priemka: 1 });
  assert.equal(s.channels.vk.posts, 0, "молчавшая площадка видна нулём, а не пропадает");
  assert.equal(s.channels.threads.usual, 100);
  assert.equal(s.top[0].id, "t1", "400 при обычных ста сильнее, чем 2000 без базы сравнения");
  assert.equal(s.top[0].ratio, 4);
  assert.deepEqual(s.followers.youtube, { now: 1352, delta: 22 });
  assert.ok(JSON.stringify(s).includes("Иван") === false && JSON.stringify(s).includes("7999") === false, "имён и телефонов в сводке нет");
  // Отчёт собирается из сводки и не падает на пустых местах.
  const tg = telegramText(s, { threads: "Threads", youtube: "YouTube", vk: "ВКонтакте", yt: "YouTube" });
  assert.match(tg, /заявок 2, вышло 3 материала/);
  assert.match(tg, /Без ответа осталось: 1/);
  assert.match(tg, /Молчали: ВКонтакте/);
  const md = markdown(s, { threads: "Threads", youtube: "YouTube", vk: "ВКонтакте" });
  assert.match(md, /## Заявки/);
  // Ролик YouTube показан досмотром, а не только просмотрами.
  assert.deepEqual(s.video.list.map((v) => [v.name, v.watchPct]), [["имя-y1", 55]]);
  assert.match(md, /## YouTube: досмотр и подписки с ролика/);
  assert.match(md, /\| имя-y1 \| 2 000 \| 55% \|/);
});

test("ролик, досмотренный заметно лучше обычного, попадает в предложения; разница в пять пунктов нет", () => {
  const base = { channels: {}, slotTable: {}, materials: [], leadsBySource: {}, clicksByChannel: {}, title: (c) => c };
  const strong = suggest({ ...base, video: { usualWatch: 40, list: [{ name: "vyrubki", watchPct: 58 }, { name: "shvy", watchPct: 44 }] } });
  assert.equal(strong.length, 1);
  assert.match(strong[0], /ролик «vyrubki» досмотрели на 58% при обычных 40%/);
  assert.deepEqual(suggest({ ...base, video: { usualWatch: 40, list: [{ name: "shvy", watchPct: 45 }] } }), [], "пять пунктов — шум раздачи");
  assert.deepEqual(suggest({ ...base, video: { usualWatch: 0, list: [{ name: "pervyj", watchPct: 70 }] } }), [], "без истории сравнивать не с чем");
});

test("предложений не больше трёх, и у каждого своя цифра", () => {
  const out = suggest({
    channels: { vk: { title: "ВКонтакте", posts: 0 } },
    slotTable: { threads: [{ time: "14:30", posts: 4, median: 60 }, { time: "19:00", posts: 5, median: 190 }, { time: "08:30", posts: 1, median: 900 }] },
    materials: [{ material: "blog:priemka", ratio: 3.2, channels: ["threads", "youtube"] }],
    leadsBySource: { yt: 4 }, clicksByChannel: { yt: 30 }, title: (c) => ({ threads: "Threads", youtube: "YouTube", yt: "YouTube" })[c] || c,
  });
  assert.equal(out.length, 3);
  assert.ok(out.some((x) => /19:00 даёт медиану 190, слот 14:30 — 60/.test(x)), "слот с одним выходом в сравнение не идёт");
  assert.ok(out.some((x) => /Заявки пришли в основном с площадки «YouTube»: 4/.test(x)));
});

test("свежий пост меряется каждый день, старый — по понедельникам, совсем старый — никогда", () => {
  assert.equal(dueToday(0, 3), true);
  assert.equal(dueToday(14, 3), true);
  assert.equal(dueToday(15, 3), false);
  assert.equal(dueToday(15, 1), true);
  assert.equal(dueToday(61, 1), false);
});

test("срок ключа: дни до даты, а без даты срок неизвестен", () => {
  const now = msk("2026-10-10T12:00:00");
  assert.equal(daysLeft("2026-10-20", now), 9);
  assert.equal(daysLeft("2026-10-09", now), -2);
  assert.equal(daysLeft("", now), null);
  assert.equal(daysLeft("не дата", now), null);
});

test("реестр переменных: имена не повторяются, обязательные зависят от машины и площадок", () => {
  const names = REGISTRY.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(required("server", []).includes("APPROVER_IDS"));
  assert.ok(!required("operator", []).includes("APPROVER_IDS"));
  assert.ok(required("server", ["threads"]).includes("THREADS_TOKEN"));
  assert.ok(!required("server", []).includes("THREADS_TOKEN"));
  // Токен бота живёт только в секретах релея.
  assert.deepEqual(REGISTRY.find((r) => r.name === "TG_BOT_TOKEN").where, ["relay"]);
});

test("срок ответа на заявку считается в рабочих часах", () => {
  // Пятница 17:00 → понедельник 09:00: рабочих минут 30 в пятницу и 30 в понедельник.
  assert.equal(workMinutes(msk("2026-10-09T17:00:00"), msk("2026-10-12T09:00:00")), 60);
  assert.equal(workMinutes(msk("2026-10-10T10:00:00"), msk("2026-10-11T18:00:00")), 0, "выходные не считаются");
  assert.equal(workMinutes(msk("2026-10-12T10:00:00"), msk("2026-10-12T10:45:00")), 45);
  const late = overdue([
    { leadId: "a", createdAt: new Date(msk("2026-10-12T08:30:00")).toISOString() },
    { leadId: "b", createdAt: new Date(msk("2026-10-12T10:20:00")).toISOString() },
  ], msk("2026-10-12T10:40:00"), 60);
  assert.deepEqual(late.map((c) => c.leadId), ["a"]);
  assert.equal(late[0].waitedMin, 130);
});

test("выброс считается от медианы своего канала, а свежие ролики в базу не идут", () => {
  const now = msk("2026-10-10T12:00:00");
  const post = (views, daysAgo, title = "ролик") => ({ title, url: `https://example.ru/${views}-${daysAgo}`, views, published: new Date(now - daysAgo * 86_400_000).toISOString() });
  const posts = [post(100, 10), post(120, 12), post(90, 14), post(110, 20), post(95, 25), post(105, 30), post(900, 8, "залетел"), post(5000, 1, "вышел вчера")];
  const r = outliers(posts, { now });
  assert.equal(r.median, 105);
  assert.deepEqual(r.found.map((p) => p.title), ["вышел вчера", "залетел"]);
  assert.equal(r.found[1].ratio, 8.6);
  assert.deepEqual(outliers(posts.slice(0, 4), { now }).found, [], "по четырём роликам «обычное» не определить");
  assert.match(digest([{ at: new Date(now).toISOString(), ratio: 8.6, source: "youtube", channel: "Канал", title: "залетел", url: "https://example.ru", views: 900, median: 105, published: new Date(now).toISOString() }], { now }), /8,6×/);
});

test("лента канала YouTube разбирается без ключа", () => {
  const xml = `<feed><entry><yt:videoId>41VEoaQmM9w</yt:videoId><title>Набор &quot;Леонардо&quot;</title><published>2023-07-21T10:00:00+00:00</published><media:group><media:community><media:statistics views="84255"/></media:community></media:group></entry><entry><title>без номера</title></entry></feed>`;
  const out = parseYoutubeFeed(xml);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { title: 'Набор "Леонардо"', url: "https://www.youtube.com/watch?v=41VEoaQmM9w", views: 84255, published: "2023-07-21T10:00:00+00:00" });
});
