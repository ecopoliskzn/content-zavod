// Сборщик новостей: разбор лент, оценка по словарю ниши, статьи сайта.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "zavod-news-"));
process.env.ZAVOD_ENV_FILE = path.join(process.env.DATA_DIR, "нет-такого.env");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { articleText, canonical, parseAtom, parseFeed, parseLinks, parseRss, parseTelegram, score, trimArticle } = await import("../src/news/parse.mjs");
const { rate } = await import("../src/news/collect.mjs");
const inbox = await import("../src/news/inbox.mjs");

const dict = JSON.parse(readFileSync(path.join(ROOT, "src", "news", "dictionary.json"), "utf8"));
const sources = JSON.parse(readFileSync(path.join(ROOT, "src", "news", "sources.json"), "utf8")).sources;

test("лента RSS: заголовок, адрес, дата, вводка; запись без адреса пропускается", () => {
  const xml = `<rss><channel><item><title><![CDATA[Площадку в Казани &laquo;приняли&raquo;]]></title><link>https://example.ru/a?utm_source=x</link><pubDate>Fri, 09 Oct 2026 10:00:00 +0300</pubDate><description>&lt;p&gt;Текст &amp;amp; ещё&lt;/p&gt;</description></item><item><title>без адреса</title></item></channel></rss>`;
  const out = parseRss(xml);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Площадку в Казани «приняли»");
  assert.equal(out[0].published, "2026-10-09T07:00:00.000Z");
  assert.equal(parseFeed(xml).length, 1);
});

test("лента Atom узнаётся сама", () => {
  const xml = `<feed><entry><title>Запись</title><link rel="alternate" href="https://example.ru/b"/><updated>2026-10-09T07:00:00Z</updated><summary>Кратко</summary></entry></feed>`;
  assert.deepEqual(parseFeed(xml), parseAtom(xml));
  assert.equal(parseAtom(xml)[0].url, "https://example.ru/b");
});

test("витрина канала Telegram: текст, адрес поста, просмотры", () => {
  const html = `<div class="tgme_widget_message_wrap"><div data-post="dvor_tatar/123"><div class="tgme_widget_message_text js-message_text" dir="auto">Сезон подошёл к концу<br/>560 дворов</div><span class="tgme_widget_message_views">1.2K</span><time datetime="2026-09-21T10:00:00+00:00"></time></div></div>`;
  const out = parseTelegram(html);
  assert.equal(out[0].url, "https://t.me/dvor_tatar/123");
  assert.equal(out[0].views, "1.2K");
  assert.match(out[0].title, /Сезон подошёл к концу/);
});

test("страница без ленты: берутся только ссылки под шаблон, короткие подписи отбрасываются", () => {
  const html = `<a href="/news/101">Новую спортивную площадку открыли в Зеленодольске</a><a href="/news/102">Далее</a><a href="/about">О министерстве и его задачах на этот год</a><a href="/news/101">Новую спортивную площадку открыли в Зеленодольске</a>`;
  const out = parseLinks(html, "https://example.ru/news/", "/news/\\d+$");
  assert.deepEqual(out.map((x) => x.url), ["https://example.ru/news/101"]);
});

test("адрес новости очищается от меток, а ссылка-счётчик Bing разворачивается", () => {
  assert.equal(canonical("https://example.ru/a/?utm_source=tg&utm_medium=x&id=5#top"), "https://example.ru/a/?id=5");
  assert.equal(canonical("https://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3A%2F%2Frealnoevremya.ru%2Fnews%2F1%3Futm_source%3Dbing"), "https://realnoevremya.ru/news/1");
});

test("словарь ниши: все правила читаются, якоря существуют", () => {
  const tags = new Set(dict.rules.map((r) => r.tag).filter(Boolean));
  for (const r of dict.rules) assert.doesNotThrow(() => new RegExp(r.re, "iu"), `правило «${r.tag}» не читается`);
  for (const a of dict.anchors) assert.ok(tags.has(a), `якоря «${a}» нет среди правил`);
  for (const r of dict.rules.filter((x) => x.unless)) assert.ok(tags.has(r.unless));
});

// Заголовки взяты из живого прогона сборщика 10.10.2026.
const pass = (title, summary = "", weight = 2) => rate({ title, summary }, weight, dict);

test("новость по теме проходит: ядро, объект в Татарстане, объект и прокуратура", () => {
  assert.equal(pass("В парке «Черное озеро» в Казани восстановят резиновое покрытие за 1,75 млн").pass, true);
  assert.equal(pass("Прокуратура заставила отремонтировать детские площадки в Тверской области").pass, true);
  assert.equal(pass("Резиновая крошка своими руками: сделал дорожку — по ней не страшно ходить").pass, true);
  assert.equal(pass("Школьный стадион в Набережных Челнах откроют после модернизации").pass, true);
});

test("шум не проходит: слова набрали вес, а темы нет", () => {
  // «травма» и «Казань» без площадки и покрытия — это футбол.
  assert.equal(pass("Четыре игрока «Рубина» пропустят матч с «Динамо» из-за травм", "Казанский клуб остался без лидеров").pass, false);
  assert.equal(pass("В Татарстане директор строительной компании предстанет перед судом за мошенничество").pass, false);
  assert.equal(pass("Пора переобуть машину: зимняя резина и шиномонтаж в Казани").pass, false);
  assert.equal(pass("Погода в Казани на выходные").pass, false);
});

test("минус-слово не топит новость, в которой есть ядро", () => {
  const r = score({ title: "Старые шины вместо зимней резины: резиновая крошка для детской площадки" }, dict.rules);
  assert.ok(r.tags.includes("ядро"));
  assert.ok(r.score >= 16, `ядро и объект должны остаться, получилось ${r.score}`);
});

test("источники: имена не повторяются, у включённых страниц без ленты задан шаблон", () => {
  const ids = sources.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of sources) {
    assert.ok(/^https:\/\//.test(s.url), `${s.id}: адрес без https`);
    assert.ok(["rss", "tg", "html"].includes(s.type), `${s.id}: неизвестный вид`);
    if (s.type === "html" && s.enabled !== false) assert.ok(s.pattern, `${s.id}: включён без шаблона ссылок`);
    if (s.type === "tg") assert.match(s.url, /^https:\/\/t\.me\/s\//);
  }
});

test("ящик новостей: запись проходит путь от новой до использованной, журнал помнит всё", () => {
  inbox.add({ id: "n1", title: "Новость", url: "https://example.ru/n1", score: 15 });
  assert.equal(inbox.known("n1"), true);
  assert.equal(inbox.byStatus("new").length, 1);
  assert.equal(inbox.setStatus("n1", "taken", "Анна"), true);
  assert.equal(inbox.byStatus("new").length, 0);
  assert.equal(inbox.byStatus("taken")[0].by, "Анна");
  assert.equal(inbox.setStatus("нет", "taken"), false);
});

test("из страницы сайта остаётся статья: без шапки, формы заявки и служебных строк", () => {
  const html = `<html><head><title>Блог</title></head><body><header><a href="/">Меню сайта и каталог</a></header><main><h1>Как проверить покрытие</h1><p>9 октября 2026 г.</p><p>4,72</p><p>5788</p><p>Свежее покрытие почти всегда выглядит красиво.</p><h2>Когда принимать</h2><ul><li>на сухом покрытии</li><li>днём</li></ul><h2>Подберем покрытие под ваш объект</h2><form><input name="phone"></form><p>Оставьте телефон</p></main><footer>Подвал</footer></body></html>`;
  const page = articleText(html);
  assert.equal(page.title, "Как проверить покрытие");
  const { text, dateText } = trimArticle(page.text, page.title, ["Подберем покрытие"]);
  assert.equal(dateText, "9 октября 2026");
  assert.match(text, /^Свежее покрытие почти всегда выглядит красиво\./);
  assert.match(text, /- на сухом покрытии/);
  assert.doesNotMatch(text, /Подберем|Оставьте телефон|5788|Меню сайта/);
});
