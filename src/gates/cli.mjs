#!/usr/bin/env node
// Проверки из командной строки: до постановки в очередь и без неё.
//
//   npm run check -- --file=content/queue/threads/2026-10-15/priemka.json
//   npm run check -- --file=priemka.txt --channel=threads            ветка текстом, реплики через ---
//   npm run check -- --text="Толщину покрытия проверяют вырубкой" --channel=telegram
//   npm run check -- --drafts                                        все черновики очереди
//
// Коды выхода: 0 пройдено · 1 есть претензии · 2 поломка окружения.
//
// ГДЕ ИСПОЛНЯЕТСЯ. Проверка «начало повторяет прошлую запись» сравнивает текст с тем,
// что уже стоит в очереди, а очередь живёт на сервере. Поэтому при заданном
// QUEUE_API_BASE проверка уходит на сервер. Без него сверка идёт с местным каталогом
// данных: на компьютере оператора он пуст, и повтор захода проверка не увидит.

import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env.mjs";
import { request } from "../lib/http.mjs";
import { splitPosts } from "../queue/format.mjs";

const flags = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
  if (m) flags[m[1]] = m[2] ?? true;
}

function entries() {
  if (flags.text) {
    const channel = String(flags.channel || "telegram");
    const kind = channel === "threads" ? "thread" : channel === "dzen" ? "article" : "post";
    return [{ channel, kind, name: "proba", material: "проба", ...(kind === "thread" ? { posts: splitPosts(String(flags.text)) } : { text: String(flags.text), title: flags.title || "" }) }];
  }
  if (!flags.file) return [];
  const file = String(flags.file);
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (file.endsWith(".json")) {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  }
  return [{ channel: String(flags.channel || "threads"), kind: "thread", name: path.basename(file).replace(/\.[^.]+$/, ""), material: String(flags.material || "проба"), posts: splitPosts(text) }];
}

async function run(cmd, args) {
  const base = env("QUEUE_API_BASE");
  if (base && !flags.local) {
    const res = await request(`${base.replace(/\/+$/, "")}/admin/queue`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env("ADMIN_API_TOKEN")}` },
      body: JSON.stringify({ cmd, args, actor: env("OPERATOR_NAME", "оператор") }),
      timeoutMs: 60_000,
    });
    if (res.kind !== "ok" && !res.data?.lines) return { code: 2, lines: [`сервер не ответил: ${res.error}`] };
    return res.data;
  }
  const { execute } = await import("../queue/commands.mjs");
  return execute(cmd, args, "проверка");
}

let code = 0;
try {
  if (flags.drafts) {
    const listed = await run("list", { status: "draft", all: true });
    if (listed.code) { console.log((listed.lines || []).join("\n")); code = listed.code; }
    for (const e of listed.data || []) {
      const out = await run("check", { ref: e.id });
      console.log(`\n${e.channel} · ${e.name}`);
      for (const line of out.lines || []) console.log(`  ${line}`);
      code = Math.max(code, out.code || 0);
    }
    if (!(listed.data || []).length) console.log("черновиков нет");
  } else {
    const list = entries();
    if (!list.length) {
      console.error("что проверить: --file=<json|txt> | --text=\"…\" --channel=<площадка> | --drafts");
      code = 1;
    }
    for (const entry of list) {
      const out = await run("check", { entry });
      if (list.length > 1) console.log(`\n${entry.channel} · ${entry.name}`);
      for (const line of out.lines || []) console.log(line);
      code = Math.max(code, out.code ?? 2);
    }
  }
} catch (e) {
  console.error(`сбой проверки: ${e?.message || e}`);
  code = 2;
}
process.exitCode = code;
