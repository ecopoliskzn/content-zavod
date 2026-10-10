// Сообщения в рабочую группу Telegram: отчёт, тревога, карточка, пакет на ручную выкладку.
//
// ЧЕТЫРЕ ВИДА, И БОЛЬШЕ НЕ НУЖНО:
//   отчёт   — утром план дня, вечером сводка, в понедельник неделя. Без кнопок;
//   тревога — что-то сломалось. Несёт ДЕЙСТВИЕ, а не факт, и это действие выполнимо
//             с телефона: ссылка или кнопка. «Запустите npm run …» в метро не выполнить;
//   карточка — нужно решение человека: согласование, заявка, новость. С кнопками;
//   пакет   — выложить руками (Дзен): готовый текст и срок.
//
// ПОВТОР ТРЕВОГИ НЕ ЧАЩЕ РАЗА В ШЕСТЬ ЧАСОВ. Сторожа ходят каждый час и видят одну и ту
// же беду, пока её не устранят. Первый живой прогон сторожа у нас отправил девять
// сообщений подряд, и владелец справедливо перестал их читать. Ключ тревоги собирается
// из состава беды: тот же состав молчит, новая проблема приходит сразу.
//
// Группа с темами (форум): у каждой темы свой номер. Если тем нет, всё идёт в общий чат.

import { dataPath, env } from "./env.mjs";
import { readJson, writeJson } from "./files.mjs";
import { chunks, h, keyboard, sendMessage } from "./telegram.mjs";

const TOPIC_ENV = {
  approval: "TG_TOPIC_APPROVAL",
  leads: "TG_TOPIC_LEADS",
  reports: "TG_TOPIC_REPORTS",
  alerts: "TG_TOPIC_ALERTS",
  news: "TG_TOPIC_NEWS",
  packages: "TG_TOPIC_PACKAGES",
  comments: "TG_TOPIC_COMMENTS",
};

export const groupId = () => env("TG_GROUP_ID");

function topicExtra(topic) {
  const id = env(TOPIC_ENV[topic] || "");
  return id ? { message_thread_id: Number(id) } : {};
}

/** Сообщение в тему группы. Возвращает { ok, messageId, error }. */
export async function toGroup(topic, text, { buttons, extra = {} } = {}) {
  const chat = groupId();
  if (!chat) return { ok: false, error: "нет TG_GROUP_ID: рабочая группа не задана" };
  let last = { ok: false, error: "пустой текст" };
  const parts = chunks(text);
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const res = await sendMessage(chat, parts[i], { ...topicExtra(topic), ...(isLast && buttons ? keyboard(buttons) : {}), ...extra });
    last = res.kind === "ok" ? { ok: true, messageId: res.result?.message_id } : { ok: false, error: res.error };
    if (!last.ok) {
      // Сбой отправки не глотаем молча: в журнале процесса он обязан быть виден.
      console.error(`[notify] сообщение в группу (${topic}) не ушло: ${res.error}`);
      break;
    }
  }
  return last;
}

export const report = (text) => toGroup("reports", text);

const ALERTS = () => dataPath("alerts.json");
const SIX_HOURS = 6 * 3600_000;

/**
 * Тревога с защитой от повторов.
 * @param {string} key   ключ беды: одинаковый ключ молчит шесть часов
 * @param {string} text  что случилось, одной-двумя фразами
 * @param {{ action: string, buttons?: any[] }} opts action обязателен: что нажать или открыть
 */
export async function alert(key, text, { action, buttons } = {}) {
  if (!action) throw new Error(`тревога «${key}» без действия: напишите, что человеку нажать или открыть`);
  const seen = readJson(ALERTS(), {}) || {};
  const now = Date.now();
  if (seen[key] && now - seen[key] < SIX_HOURS) return { ok: true, skipped: true };
  const res = await toGroup("alerts", `⚠️ ${text}\n\n<b>Что сделать:</b> ${action}`, { buttons });
  if (res.ok) {
    seen[key] = now;
    // Чистим ключи старше недели, чтобы файл не рос.
    for (const k of Object.keys(seen)) if (now - seen[k] > 7 * 86_400_000) delete seen[k];
    writeJson(ALERTS(), seen);
  }
  return res;
}

/** Беда прошла: ключ снимается, следующая такая же придёт сразу. */
export function resolve(key) {
  const seen = readJson(ALERTS(), {}) || {};
  if (seen[key]) {
    delete seen[key];
    writeJson(ALERTS(), seen);
  }
}

export { h };
