#!/usr/bin/env node
// Статьи сайта клиента: главный источник тем. Блог читается с открытой страницы,
// доступ к сайту и его счётчикам для этого не нужен.
//
//   node src/news/site-articles.mjs              что нового в блоге (ничего не пишет на диск проекта)
//   node src/news/site-articles.mjs --save       сохранить тексты новых статей в content/articles/
//   node src/news/site-articles.mjs --save --all пересохранить все
//   node src/news/site-articles.mjs --notify     новые статьи карточками в рабочую группу (для cron)
//
// Зачем сохранять текст. Сессия пишет ветки и посты ИЗ СТАТЬИ: цифры, шаги и формулировки
// берутся оттуда и ложатся в поле facts записи вместе с адресом статьи. Выдумывать цифры
// про покрытия нельзя: текст выходит от имени производителя.
//
// Каждая сохранённая статья — файл content/articles/<слаг>.md с шапкой: заголовок,
// адрес, дата, когда снята. Правок сайта задним числом скрипт не отслеживает: если
// статью переписали, её пересохраняют с --all.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "../lib/config.mjs";
import { PROJECT_ROOT, dataPath } from "../lib/env.mjs";
import { readJson, writeJson } from "../lib/files.mjs";
import { sleep } from "../lib/http.mjs";
import { fetchText } from "./collect.mjs";
import { add, known } from "./inbox.mjs";
import { articleText, parseLinks, trimArticle } from "./parse.mjs";

const OUT = path.join(PROJECT_ROOT, "content", "articles");
const flag = (name) => process.argv.includes(`--${name}`);

/** Слаг статьи из адреса: последний непустой кусок пути. */
export const slugOf = (url) => new URL(url).pathname.split("/").filter(Boolean).pop() || "statya";

/** Список статей со страницы блога. */
export async function listArticles(blogUrl) {
  const html = await fetchText(blogUrl);
  const base = new URL(blogUrl);
  const pattern = `^${base.origin.replace(/[.]/g, "\\.")}${base.pathname.replace(/\/$/, "")}/[^/?#]+/?$`;
  return parseLinks(html, blogUrl, pattern).map((a) => {
    // В тексте ссылки на странице блога перед заголовком стоят дата и оценка статьи:
    // «9 октября 2026 г. 4,3 Заголовок». Дату забираем, оценку отбрасываем.
    const m = a.title.match(/^(\d{1,2}\s+\p{L}+\s+\d{4})\s*г?\.?\s+(?:\d(?:[.,]\d+)?\s+)?(.+)$/u);
    return { ...a, title: m ? m[2].trim() : a.title, dateText: m ? m[1] : "", slug: slugOf(a.url) };
  });
}

export async function saveArticle(article) {
  const html = await fetchText(article.url);
  const page = articleText(html);
  // Заголовок страницы бывает с хвостом «… — Экополис»: хвост названия сайта убираем.
  const title = page.title && !/^блог$/i.test(page.title) ? page.title.replace(/\s+[—|-]\s+Экополис.*$/i, "") : article.title;
  const { text, dateText } = trimArticle(page.text, title, config().client.articleEndMarkers || []);
  mkdirSync(OUT, { recursive: true });
  const body = [
    "---",
    `title: ${JSON.stringify(title || article.title)}`,
    `url: ${article.url}`,
    `slug: ${article.slug}`,
    `published: ${JSON.stringify(dateText || article.dateText || "")}`,
    `fetched: ${new Date().toISOString().slice(0, 10)}`,
    `words: ${text.split(/\s+/).length}`,
    "source: сайт клиента, текст не правился",
    "---",
    "",
    `# ${title || article.title}`,
    "",
    text,
    "",
  ].join("\n");
  writeFileSync(path.join(OUT, `${article.slug}.md`), body, "utf8");
  return { slug: article.slug, words: text.split(/\s+/).length };
}

async function main() {
  const blog = config().client.blog;
  const index = readJson(dataPath("articles", "index.json"), { seen: {} }) || { seen: {} };
  const list = await listArticles(blog);
  const fresh = list.filter((a) => !index.seen[a.slug]);
  console.log(`статей в блоге: ${list.length}, новых с прошлого прохода: ${fresh.length}`);
  for (const a of fresh.slice(0, 30)) console.log(`  новая: ${a.title.slice(0, 90)}\n         ${a.url}`);

  if (flag("save")) {
    const targets = flag("all") ? list : list.filter((a) => !existsSync(path.join(OUT, `${a.slug}.md`)));
    for (const a of targets) {
      try {
        const saved = await saveArticle(a);
        console.log(`  сохранена: ${saved.slug} (${saved.words} слов)`);
      } catch (e) {
        console.error(`  не сохранилась ${a.slug}: ${e.message}`);
        process.exitCode = 1;
      }
      await sleep(600);
    }
  }

  // Первый проход только запоминает блог: иначе в группу уйдут карточки на все статьи
  // за прошлые годы. Новой считается статья, появившаяся после первого прохода.
  const firstRun = !Object.keys(index.seen).length;
  if (flag("notify") && !firstRun) {
    for (const a of fresh) {
      const id = createHash("sha1").update(a.url).digest("hex").slice(0, 16);
      if (!known(id)) add({ id, source: "site", sourceTitle: "Блог клиента", title: a.title, url: a.url, published: "", summary: "Новая статья на сайте: из неё делаются ветка, пост и сценарий ролика.", score: 99, tags: ["своя статья"] });
    }
  }
  for (const a of list) index.seen[a.slug] = index.seen[a.slug] || new Date().toISOString().slice(0, 10);
  writeJson(dataPath("articles", "index.json"), index);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`сбой: ${e?.stack || e}`); process.exitCode = 2; });
}
