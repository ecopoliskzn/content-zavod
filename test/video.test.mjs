// Ролики: серии, сборка описания, проверка названия и первой строки, опись канала.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "zavod-video-"));
process.env.ZAVOD_ENV_FILE = path.join(process.env.DATA_DIR, "нет-такого.env");

const { composeDescription, hashtags, neighbours, pinnedComment, relations, sortByViews, swapRelations, withVideo } = await import("../src/video/series.mjs");
const { describeChannel, seconds } = await import("../src/video/youtube-tools.mjs");
const { spoilers, video, speech } = await import("../src/gates/rules.mjs");
const { videoId } = await import("../src/channels/youtube.mjs");
const { idFromLink } = await import("../src/channels/rutube.mjs");
const { postRef } = await import("../src/channels/vk.mjs");
const { validate, normalize, contentHash } = await import("../src/queue/format.mjs");

const registry = {
  series: [
    { key: "val", title: "Электровал", order: "parts", playlistId: "PLval", videos: [{ id: "aaaaaaaaaa1", title: "Часть 1" }, { id: "aaaaaaaaaa2", name: "val-2", title: "Часть 2" }, { name: "val-3", title: "Часть 3" }] },
    { key: "proverka", title: "Проверка временем", order: "views", playlistId: "", videos: [{ id: "bbbbbbbbbb1", title: "После зимы" }, { id: "bbbbbbbbbb2", title: "Через год" }, { id: "bbbbbbbbbb3", title: "В мороз" }] },
  ],
};
const ctx = { registry, base: "https://go.example.ru", bot: "eco_bot", about: "«Экополис»: покрытия из резиновой крошки.", links: { priemka: { title: "Чек-лист приёмки" } } };
const entry = (over = {}) => ({ channel: "youtube", kind: "short", name: "val-2", title: "Электровал греется сорок минут, и это не поломка", text: "Вал включают до приезда бригады.\n\nВ части 3: как он идёт по смеси.", hashtags: ["резиновоепокрытие", "#укладка", "электро вал"], goSlug: "priemka", botKey: "priemka", series: "val", ...over });

test("у серии по частям есть прошлая и следующая; невышедшая часть соседом не считается", () => {
  const n = neighbours(registry, { name: "val-2" });
  assert.equal(n.prev.id, "aaaaaaaaaa1");
  assert.equal(n.next, null, "третья часть ещё не вышла: ссылаться не на что");
  const first = neighbours(registry, { videoId: "aaaaaaaaaa1" });
  assert.equal(first.prev, null);
  assert.equal(first.next.id, "aaaaaaaaaa2");
});

test("загруженный, но ещё закрытый ролик соседом не считается: до срока выхода на него не ссылаются", () => {
  const now = Date.parse("2026-10-12T06:00:00Z");
  const scheduled = { series: [{ key: "val", title: "Электровал", order: "parts", playlistId: "PLval", videos: [{ id: "aaaaaaaaaa1", title: "Часть 1" }, { id: "aaaaaaaaaa2", title: "Часть 2", publishAt: "2026-10-13T07:00:00.000Z" }] }, { key: "t", title: "Тема", order: "views", videos: [{ id: "cccccccccc1" }, { id: "cccccccccc2", publishAt: "2026-10-13T07:00:00.000Z" }, { id: "cccccccccc3" }] }] };
  assert.equal(neighbours(scheduled, { videoId: "aaaaaaaaaa1" }, now).next, null, "вторая часть ещё закрыта");
  assert.equal(neighbours(scheduled, { videoId: "aaaaaaaaaa1" }, Date.parse("2026-10-13T07:05:00Z")).next.id, "aaaaaaaaaa2", "после срока ссылка появляется");
  // Сам отложенный ролик на вышедшую часть ссылаться может: она уже открыта.
  assert.equal(neighbours(scheduled, { videoId: "aaaaaaaaaa2" }, now).prev.id, "aaaaaaaaaa1");
  assert.deepEqual(neighbours(scheduled, { videoId: "cccccccccc1" }, now).also.map((v) => v.id), ["cccccccccc3"]);
  const rel = relations({ name: "", series: "val" }, { registry: scheduled, videoId: "aaaaaaaaaa1", now });
  assert.ok(!rel.some((l) => l.includes("aaaaaaaaaa2")), "в блоке ссылок закрытого ролика нет");
});

test("у тематической серии соседи — два других ролика, без «следующей части»", () => {
  const n = neighbours(registry, { videoId: "bbbbbbbbbb2" });
  assert.equal(n.next, null);
  assert.deepEqual(n.also.map((v) => v.id), ["bbbbbbbbbb1", "bbbbbbbbbb3"]);
});

test("описание: текст, строка о компании, ссылки с меткой площадки, хэштеги, блок связей", () => {
  const d = composeDescription(entry(), { ...ctx, videoId: "aaaaaaaaaa2" });
  const blocks = d.split("\n\n");
  assert.equal(blocks[0], "Вал включают до приезда бригады.", "первая строка описания — первая строка согласованного текста");
  assert.match(d, /Чек-лист приёмки: https:\/\/go\.example\.ru\/go\/priemka\?c=yt&p=val-2/);
  assert.match(d, /https:\/\/t\.me\/eco_bot\?start=yt-priemka/);
  assert.match(d, /#резиновоепокрытие #укладка #электровал/);
  assert.match(d, /Серия «Электровал»: https:\/\/www\.youtube\.com\/playlist\?list=PLval/);
  assert.match(d, /Предыдущая часть: https:\/\/youtu\.be\/aaaaaaaaaa1 \| Часть 1/);
  assert.doesNotMatch(d, /Следующая часть/);
});

test("на Rutube и во ВКонтакте метка своя, а ссылок на ролики YouTube нет", () => {
  const d = composeDescription(entry({ channel: "rutube" }), ctx);
  assert.match(d, /\?c=rt&p=val-2/);
  assert.match(d, /start=rt-priemka/);
  assert.doesNotMatch(d, /youtu\.be|playlist\?list/);
});

test("хэштегов не больше пяти, решётка одна, пробелов внутри нет", () => {
  assert.equal(hashtags(["а", "#б", "в г", "д", "е", "ж", "з"]), "#а #б #вг #д #е");
  assert.equal(hashtags([]), "");
});

test("закреплённый комментарий несёт ту же ссылку, что описание", () => {
  const text = pinnedComment(entry(), ctx);
  assert.match(text, /^Чек-лист приёмки: https:\/\/go\.example\.ru\/go\/priemka\?c=yt&p=val-2/);
  assert.match(text, /отвечает специалист/);
});

test("у старого ролика меняется только то, что завод дописал сам; строки клиента остаются", () => {
  // «Смотрите также» клиент когда-то написал сам: это его текст, а не наш блок.
  const old = "Электровал в работе.\nТелефон в описании канала.\n\nСмотрите также: https://youtu.be/xxxxxxxxxxx";
  const rel = relations({ name: "", series: "val" }, { ...ctx, videoId: "aaaaaaaaaa1" });
  const first = swapRelations(old, rel, null);
  assert.ok(first.description.startsWith(old), "описание клиента цело, блок дописан в конец");
  assert.match(first.description, /Следующая часть: https:\/\/youtu\.be\/aaaaaaaaaa2/);
  assert.equal(first.state.first, old);
  // Повторный запуск с тем же блоком ничего не меняет и ничего не задваивает.
  assert.equal(swapRelations(first.description, rel, first.state).description, first.description);
  assert.equal(swapRelations("Просто текст.", [], null).description, "Просто текст.");
});

test("порядок серии по просмотрам: лучший первым", () => {
  const views = new Map([["bbbbbbbbbb1", 10], ["bbbbbbbbbb2", 900], ["bbbbbbbbbb3", 50]]);
  assert.deepEqual(sortByViews(registry.series[1].videos, views).map((v) => v.id), ["bbbbbbbbbb2", "bbbbbbbbbb3", "bbbbbbbbbb1"]);
});

test("вышедший ролик встаёт в серию на место своей записи, а не второй строкой", () => {
  const next = withVideo(registry, "val", { id: "aaaaaaaaaa3", name: "val-3", title: "Часть 3" });
  assert.equal(next.series[0].videos.length, 3);
  assert.equal(next.series[0].videos[2].id, "aaaaaaaaaa3");
  assert.equal(registry.series[0].videos[2].id, undefined, "исходный реестр не меняется");
  assert.throws(() => withVideo(registry, "нет-такой", { id: "x" }), (e) => e.code === "RULE");
});

test("первая строка описания не повторяет число из названия", () => {
  assert.deepEqual(spoilers("На 500 метров покрытия делают 14 вырубок", "На 500 метров положено 14 вырубок.").common.sort(), ["14", "500"]);
  assert.deepEqual(spoilers("На 500 метров покрытия делают 14 вырубок", "Толщину на глаз не определить.\n\n14 вырубок на 500 метров.").common, []);
  // Число в адресе ссылки спойлером не считается: это техническая метка.
  assert.deepEqual(spoilers("Смета выросла на 300 тысяч", "Материал: https://go.example.ru/go/smeta-300").common, []);
});

test("проверка ролика: спойлер останавливает, остальное только замечания", () => {
  const bad = video(entry({ title: "На 500 метров делают 14 вырубок", text: "14 вырубок на 500 метров: так положено." }));
  assert.equal(bad.block.length, 1);
  assert.match(bad.block[0], /первая строка описания повторяет/);
  const ok = video(entry());
  assert.deepEqual(ok.block, []);
  assert.deepEqual(ok.warn, []);
  const warned = video(entry({ title: "Как принять площадку", goSlug: "", botKey: "", hashtags: [], text: "Приёмка 21–22 октября.\n#приёмка" }));
  assert.equal(warned.block.length, 0);
  assert.ok(warned.warn.some((w) => /похоже на тему/.test(w)));
  assert.ok(warned.warn.some((w) => /нет прямой ссылки/.test(w)));
  assert.ok(warned.warn.some((w) => /дата/.test(w)));
  assert.ok(warned.warn.some((w) => /нет хэштегов/.test(w)));
  assert.ok(warned.warn.some((w) => /хэштеги в самом тексте/.test(w)));
});

test("подпись рилса: длинная первая строка и ссылка дают замечания, но не останавливают", () => {
  const v = video({ channel: "instagram", kind: "reel", text: `${"Очень длинная первая строка подписи ".repeat(3)}\nhttps://example.ru` });
  assert.deepEqual(v.block, []);
  assert.equal(v.warn.length, 2);
});

test("кодовое слово бота останавливает запись везде, кроме Instagram", () => {
  const words = { codeWords: ["ПРИЁМКА"] };
  const yt = speech({ channel: "youtube", kind: "short", title: "Акт подписан", text: "Напишите ПРИЁМКА в комментариях." }, words);
  assert.ok(yt.block.some((b) => /кодовое слово бота/.test(b)));
  const ig = speech({ channel: "instagram", kind: "reel", text: "Напишите ПРИЁМКА в комментариях." }, words);
  assert.deepEqual(ig.block, []);
  // Строчными это обычное слово, и запрещать его нельзя.
  const plain = speech({ channel: "youtube", kind: "short", title: "Акт подписан", text: "Приёмка идёт на сухом покрытии." }, words);
  assert.deepEqual(plain.block, []);
});

test("ответ на комментарий: свой вид записи, нужен текст и ссылка на комментарий", () => {
  const good = normalize({ channel: "youtube", kind: "reply", name: "otvet-1", material: "comment:youtube:abc", date: "2030-03-12", time: "12:00", text: "Толщину подтверждают вырубкой.", link: "https://www.youtube.com/watch?v=aaaaaaaaaa1&lc=abc" });
  assert.deepEqual(validate(good), []);
  const bad = validate(normalize({ ...good, text: "", link: "" }));
  assert.ok(bad.some((b) => /нет текста/.test(b)));
  assert.ok(bad.some((b) => /нет ссылки на комментарий/.test(b)));
});

test("хэштеги и ссылки ролика входят в согласованное содержимое, серия не входит", () => {
  const a = contentHash(entry());
  assert.notEqual(a, contentHash(entry({ hashtags: ["другое"] })));
  assert.notEqual(a, contentHash(entry({ goSlug: "rashod" })));
  assert.equal(a, contentHash(entry({ series: "proverka", seeAlso: ["bbbbbbbbbb1"] })), "связи между роликами согласия не требуют");
});

test("опись канала: отрыв от медианы, отклик на сотню, короткий по длине", () => {
  const item = (id, views, likes, duration) => ({ id, snippet: { title: ` Ролик ${id} `, publishedAt: "2026-01-02T10:00:00Z" }, statistics: { viewCount: String(views), likeCount: String(likes), commentCount: "0" }, contentDetails: { duration } });
  const s = describeChannel({ channel: { id: "UCx", snippet: { title: "Канал" }, statistics: { subscriberCount: "1330" } }, items: [item("a", 100, 5, "PT30S"), item("b", 1000, 10, "PT3M20S"), item("c", 300, 0, "PT1M")], watch: new Map([["b", { watchPct: 41.5, subs: 3 }]]), now: Date.parse("2026-10-10T00:00:00Z") });
  assert.equal(s.medianViews, 300);
  assert.equal(s.subscribers, 1330);
  assert.deepEqual(s.list.map((v) => v.id), ["b", "c", "a"], "по убыванию просмотров");
  assert.equal(s.list[0].ratio, 3.33);
  assert.equal(s.list[0].short, false);
  assert.equal(s.list[0].watchPct, 41.5);
  assert.equal(s.list[2].per100, 5);
  assert.equal(s.shorts, 2);
  assert.equal(s.list[1].title, "Ролик c");
});

test("длина ролика, номера роликов и записей из ссылок", () => {
  assert.equal(seconds("PT1H2M3S"), 3723);
  assert.equal(seconds("PT45S"), 45);
  assert.equal(seconds(""), 0);
  assert.equal(videoId("41VEoaQmM9w"), "41VEoaQmM9w");
  assert.equal(videoId("https://www.youtube.com/watch?v=41VEoaQmM9w&lc=x"), "41VEoaQmM9w");
  assert.equal(videoId("https://youtu.be/41VEoaQmM9w"), "41VEoaQmM9w");
  assert.equal(videoId("https://www.youtube.com/shorts/41VEoaQmM9w"), "41VEoaQmM9w");
  assert.equal(videoId("не ссылка"), "");
  assert.equal(idFromLink("https://rutube.ru/video/7716bd3e665725c3c008ae7ab4ff02e2/"), "7716bd3e665725c3c008ae7ab4ff02e2");
  assert.equal(idFromLink("https://rutube.ru/shorts/7716bd3e665725c3c008ae7ab4ff02e2/"), "7716bd3e665725c3c008ae7ab4ff02e2");
  assert.equal(postRef({ externalId: "-123_45" }), "-123_45");
  assert.equal(postRef({ externalId: "https://vk.com/wall-123_45" }), "-123_45");
  assert.equal(postRef({ externalId: "", link: "" }), "");
});

test("номер загруженного ролика не дошёл до сервера: повтор команды второй ролик не грузит, срок с ролика снят", async () => {
  const { spawnSync } = await import("node:child_process");
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(path.join(os.tmpdir(), "zavod-upload-"));
  const state = path.join(dir, "state.json");
  const queueEntry = {
    id: "aaaaaaaaaaaaaaaa", channel: "youtube", kind: "short", name: "rolik-1", material: "blog:primer", date: "2030-03-14", time: "15:00", status: "approved",
    title: "Толщину покрытия проверили вырубкой при заказчике", text: "Толщину по внешнему виду не оценить.", media: [{ type: "video", url: "https://s3.example.ru/rolik.mp4" }],
    hashtags: ["покрытие"], tags: [], contentHash: "1111111111111111", extra: {},
  };
  writeFileSync(state, JSON.stringify({ uploads: 0, publishAt: "", entry: queueEntry }));
  const clip = path.join(dir, "rolik.mp4");
  writeFileSync(clip, "байты ролика");
  const receipt = path.join(dir, "mirror", "uploads", `${queueEntry.id}.json`);
  const base = { ...process.env };
  for (const k of ["DATA_DIR", "TG_BOT_TOKEN", "TG_GROUP_ID", "TG_RELAY_URL"]) delete base[k];
  const run = (extra) => spawnSync(process.execPath, ["--import", pathToFileURL(path.join(here, "helpers", "yt-stub.mjs")).href, path.join(here, "..", "src", "video", "youtube-cli.mjs"), "--upload", "--id=rolik-1", `--file=${clip}`], {
    encoding: "utf8",
    env: { ...base, ZAVOD_ENV_FILE: path.join(dir, "нет-такого.env"), DATA_DIR: path.join(dir, "data"), MIRROR_DIR: path.join(dir, "mirror"), QUEUE_API_BASE: "https://zavod.test", ADMIN_API_TOKEN: "k", YOUTUBE_CLIENT_ID: "i", YOUTUBE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YT_STUB_STATE: state, YT_STUB_EXTRA: extra },
  });
  const read = () => JSON.parse(readFileSync(state, "utf8"));

  // Первый запуск: ролик загружен со сроком, а запись о его номере до сервера не дошла.
  const first = run("fail");
  assert.equal(first.status, 2, first.stderr);
  assert.equal(read().uploads, 1);
  assert.equal(read().publishAt, "", "срок выхода с ролика, о котором запись не знает, снят: сам он не откроется");
  assert.match(first.stderr, /номер ролика не записался в очередь/);
  assert.match(first.stderr, /второй раз ролик не загрузится/);
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).videoId, "vvvvvvvvvvv");

  // Повтор той же команды: второй ролик на канале не появляется, номер дозаписан.
  const second = run("ok");
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /ролик уже загружен прошлым запуском/);
  const after = read();
  assert.equal(after.uploads, 1, "второй загрузки не было");
  assert.deepEqual([after.entry.extra.youtubeId, after.entry.extra.youtubeHash], ["vvvvvvvvvvv", "1111111111111111"]);
  assert.equal(existsSync(receipt), false, "квитанция убрана, когда номер записан");
});
