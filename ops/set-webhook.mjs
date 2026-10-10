#!/usr/bin/env node
// Разовая настройка бота: куда Telegram шлёт обновления и какие команды видны в меню.
// Запускается на сервере после того, как подняты релей и сервер завода:
//   node ops/set-webhook.mjs --who      до установки адреса: показать номера группы, тем и людей
//   node ops/set-webhook.mjs            поставить адрес обновлений и команды
//   node ops/set-webhook.mjs --info     показать, что стоит сейчас
//
// Обновления Telegram шлёт на релей (до сервера в России он не дотягивается), релей
// передаёт их серверу. Секрет обновлений (TG_WEBHOOK_SECRET) знают трое: Telegram,
// релей и сервер. Значение скрипт не печатает.
//
// --who нужен один раз: узнать номер рабочей группы, номера её тем и номера людей,
// которые будут утверждать публикации. Перед запуском каждый из них пишет по одному
// сообщению в каждую тему группы. Тексты сообщений команда не показывает.

import { env, need } from "../src/lib/env.mjs";
import { tg } from "../src/lib/telegram.mjs";

if (process.argv.includes("--who")) {
  const r = await tg("getUpdates", { limit: 100, allowed_updates: ["message"] });
  if (r.kind !== "ok") {
    console.error(`не получилось спросить: ${r.error}`);
    console.error("если адрес обновлений уже поставлен, эта команда не работает: номера смотрят до установки адреса");
    process.exitCode = 2;
  } else {
    const chats = new Map();
    const people = new Map();
    for (const u of r.result || []) {
      const m = u.message;
      if (!m) continue;
      const chat = chats.get(m.chat.id) || { title: m.chat.title || m.chat.type, forum: Boolean(m.chat.is_forum), topics: new Map() };
      // Название темы приходит в служебном сообщении о её создании и в ответах внутри темы.
      const topicName = m.forum_topic_created?.name || m.reply_to_message?.forum_topic_created?.name || "";
      if (m.message_thread_id) chat.topics.set(m.message_thread_id, topicName || chat.topics.get(m.message_thread_id) || "");
      chats.set(m.chat.id, chat);
      if (m.from && !m.from.is_bot) people.set(m.from.id, [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || "");
    }
    if (!chats.size) console.log("сообщений нет: напишите по одному сообщению в каждую тему рабочей группы и повторите");
    for (const [id, c] of chats) {
      console.log(`чат ${id} · ${c.title}${c.forum ? " · с темами" : ""}`);
      for (const [topic, name] of c.topics) console.log(`  тема ${topic}${name ? ` · ${name}` : ""}`);
    }
    for (const [id, name] of people) console.log(`человек ${id} · ${name}`);
    console.log("\nномер чата → TG_GROUP_ID, номера тем → TG_TOPIC_*, номера людей → APPROVER_IDS и STAFF_IDS");
  }
} else if (process.argv.includes("--info")) {
  const r = await tg("getWebhookInfo");
  if (r.kind !== "ok") { console.error(`не получилось спросить: ${r.error}`); process.exitCode = 2; }
  else console.log(`адрес: ${r.result.url || "не задан"}\nв очереди обновлений: ${r.result.pending_update_count}\nпоследняя ошибка: ${r.result.last_error_message || "нет"}`);
} else {
  const relay = need("TG_RELAY_URL").replace(/\/+$/, "");
  const set = await tg("setWebhook", { url: `${relay}/tg/webhook`, secret_token: need("TG_WEBHOOK_SECRET"), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  console.log(set.kind === "ok" ? `✓ обновления идут на ${relay}/tg/webhook` : `✗ адрес не поставлен: ${set.error}`);
  // В личном чате людям видны две команды, в рабочей группе — команды пульта.
  const priv = await tg("setMyCommands", { commands: [{ command: "start", description: "Материалы и связь со специалистом" }, { command: "stop", description: "Остановить бота и отозвать согласия" }], scope: { type: "all_private_chats" } });
  const group = env("TG_GROUP_ID") ? await tg("setMyCommands", { commands: [{ command: "plan", description: "Что стоит на сегодня" }, { command: "day", description: "Что вышло сегодня" }, { command: "waiting", description: "Что ждёт согласования" }, { command: "stop_release", description: "Остановить выпуск" }, { command: "start_release", description: "Включить выпуск" }, { command: "help", description: "Как пользоваться" }], scope: { type: "chat", chat_id: env("TG_GROUP_ID") } }) : { kind: "ok" };
  console.log(priv.kind === "ok" && group.kind === "ok" ? "✓ команды бота поставлены" : `⚠ команды не поставлены: ${priv.error || group.error}`);
  if (set.kind !== "ok") process.exitCode = 1;
}
