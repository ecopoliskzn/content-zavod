#!/usr/bin/env node
// Очередь из командной строки.
//
//   npm run queue -- add --file=content/queue/threads/2026-10-15/priemka.json
//   npm run queue -- add --file=priemka.txt --channel=threads --name=priemka --material=blog:kak-proverit
//   npm run queue -- list [--channel=threads] [--status=review] [--days=7] [--all]
//   npm run queue -- show <номер|имя> [--history]
//   npm run queue -- check <номер|имя>        проверки: 0 пройдены · 1 претензии · 2 поломка
//   npm run queue -- submit [<номер|имя>]     на согласование в группу; без номера — все черновики
//   npm run queue -- inbox                    правки от утверждающего
//   npm run queue -- move <номер|имя> --date=2026-10-16 --time=19:00 | --next
//   npm run queue -- cancel <номер|имя> [--reason=…]
//   npm run queue -- slots [--channel=threads] [--count=5]
//   npm run queue -- pause [--reason=…] | resume      рубильник выпуска на сервере
//   npm run queue -- mark <номер|имя> --link=… [--externalId=…]   вышла не через сервер
//   npm run queue -- news [--status=taken] [--json]             ящик новостей: что взято в работу
//   npm run queue -- news <номер> --status=used                 новость стала материалом
//   npm run queue -- comments [--status=new] [--json]           комментарии, которые ждут ответа
//   npm run queue -- comments <номер> --status=skipped          ответ не нужен
//
// ГДЕ ИСПОЛНЯЕТСЯ. Хозяин очереди — сервер. Если в окружении задан QUEUE_API_BASE, команда
// уходит на сервер (ручка /admin/queue, ключ ADMIN_API_TOKEN) и файл очереди на компьютере
// оператора не трогается вовсе. Без QUEUE_API_BASE команда работает с местным каталогом
// данных: так она запускается на самом сервере и в тестах.
//
// Флаги только латиницей: планировщик Windows читает .cmd в своей кодировке и русские
// флаги ломает (у нас так не вышли девять веток).

import { readFileSync } from "node:fs";
import path from "node:path";
import { env, wrongUser } from "../lib/env.mjs";
import { request } from "../lib/http.mjs";
import { splitPosts } from "./format.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "list";
const flags = {};
const positional = [];
for (const a of argv.slice(1)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
  if (m) flags[m[1]] = m[2] ?? true;
  else positional.push(a);
}

/** Файл записи → одна или несколько записей очереди. */
function readEntries(file) {
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (file.endsWith(".json")) {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  }
  // Текстовый файл — ветка: реплики через строку из трёх дефисов.
  return [{
    channel: flags.channel || "threads",
    kind: "thread",
    name: flags.name || path.basename(file).replace(/\.[^.]+$/, ""),
    material: flags.material || "",
    date: flags.date || "",
    time: flags.time || "",
    posts: splitPosts(text),
    ...(flags.image ? { media: [{ type: "image", url: flags.image }] } : {}),
  }];
}

function buildArgs() {
  const args = { ...flags, ref: positional[0] };
  if (cmd === "add") {
    if (!flags.file) throw Object.assign(new Error("нужен --file=<путь к json или txt>"), { code: "RULE" });
    args.entries = readEntries(String(flags.file)).map((e) => ({ ...e, ...(flags.date ? { date: flags.date } : {}), ...(flags.time ? { time: flags.time } : {}) }));
    delete args.file;
  }
  return args;
}

async function main() {
  let args;
  try { args = buildArgs(); } catch (e) { return { code: e.code === "RULE" ? 1 : 2, lines: [e.message] }; }
  const base = env("QUEUE_API_BASE");
  if (base && !flags.local) {
    const res = await request(`${base.replace(/\/+$/, "")}/admin/queue`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env("ADMIN_API_TOKEN")}` },
      body: JSON.stringify({ cmd, args, actor: env("OPERATOR_NAME", "оператор") }),
      timeoutMs: 60_000,
    });
    if (res.kind !== "ok" && !res.data?.lines) return { code: 2, lines: [`сервер очереди не ответил: ${res.error}`] };
    return res.data;
  }
  // Местный каталог данных: команда под root оставит в нём файлы, которые завод не прочитает.
  const foreign = wrongUser();
  if (foreign) return { code: 1, lines: [foreign] };
  const { execute } = await import("./commands.mjs");
  return execute(cmd, args, env("OPERATOR_NAME", "оператор"));
}

const out = await main();
for (const line of out.lines || []) console.log(line);
if (flags.json && out.data !== undefined) console.log(JSON.stringify(out.data, null, 1));
// Код выхода полем, без process.exit(): мгновенный выход после сетевого запроса на
// свежих Node под Windows даёт ложный код 127 при сделанной работе.
process.exitCode = out.code ?? 2;
