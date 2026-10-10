#!/usr/bin/env node
// Ссылка с меткой площадки: чтобы сессия не собирала её руками и не путала метки.
//
//   npm run link -- --slug=priemka --channel=threads --name=vyrubki-14-tochek
//   npm run link -- --bot=priemka --channel=youtube
//   npm run link -- --list                 какие слаги есть и куда они ведут
//
// --slug  короткая ссылка на страницу сайта через счётчик переходов (bot/links.json);
// --bot   ссылка в бота: он выдаст материал с этим ключом (bot/materials.json);
// --name  имя записи очереди: по нему отчёт покажет, какая публикация привела человека.
//
// Новый слаг добавляется в bot/links.json, коммитится и выкладывается на сервер. До
// выкладки проверка не пропустит запись с ним: на сервере такой ссылки ещё нет, и
// человек попал бы на главную сайта.
//
// Коды выхода: 0 напечатано · 1 такого слага или ключа нет · 2 нет адреса завода.

import path from "node:path";
import { channelNames } from "../lib/config.mjs";
import { PROJECT_ROOT, env } from "../lib/env.mjs";
import { readJson } from "../lib/files.mjs";
import { MARK, botLink, goLink, postMark } from "./marks.mjs";

const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
const links = readJson(path.join(PROJECT_ROOT, "bot", "links.json"), {}) || {};
const materials = readJson(path.join(PROJECT_ROOT, "bot", "materials.json"), []) || [];

function main() {
  if (process.argv.includes("--list")) {
    console.log("Короткие ссылки (bot/links.json):");
    for (const [slug, v] of Object.entries(links)) console.log(`  ${slug.padEnd(12)} ${v.title || ""}\n  ${" ".repeat(12)} ${v.url}`);
    console.log("\nМатериалы бота (bot/materials.json):");
    for (const m of materials) console.log(`  ${String(m.key).padEnd(12)} ${m.title || ""}`);
    console.log(`\nМетки площадок: ${Object.entries(MARK).map(([k, v]) => `${k} → ${v}`).join(", ")}`);
    return 0;
  }
  const channel = opt("channel");
  if (!channelNames().includes(channel)) {
    console.error(`какая площадка: --channel=<${channelNames().join("|")}>`);
    return 1;
  }
  const slug = opt("slug");
  const key = opt("bot");
  if (!slug && !key) {
    console.error("что за ссылка: --slug=<слаг из bot/links.json> либо --bot=<ключ материала>. Список: npm run link -- --list");
    return 1;
  }
  if (slug) {
    if (!links[slug]) { console.error(`слага «${slug}» нет в bot/links.json. Список: npm run link -- --list`); return 1; }
    const base = env("PUBLIC_BASE_URL");
    if (!base) { console.error("нет PUBLIC_BASE_URL: адрес завода не задан в файле окружения"); return 2; }
    const name = opt("name");
    if (name && postMark(name) !== name) console.error(`внимание: имя записи «${name}» попадёт в ссылку как «${postMark(name)}». Имя записи: латиница, цифры и дефис, до 32 знаков`);
    console.log(goLink(base, slug, channel, name));
  }
  if (key) {
    if (!materials.some((m) => String(m.key) === key)) { console.error(`материала «${key}» нет в bot/materials.json. Список: npm run link -- --list`); return 1; }
    const bot = env("TG_BOT_USERNAME");
    if (!bot) { console.error("нет TG_BOT_USERNAME: имя бота не задано в файле окружения"); return 2; }
    console.log(botLink(bot, channel, key));
  }
  return 0;
}

process.exitCode = main();
