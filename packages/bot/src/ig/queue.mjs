// Очередь "досылки" событий Instagram: вебхук кладёт, движок забирает.
// Порт lib/ig/queue.ts из исходного проекта, без изменения поведения.
//
// ЗАЧЕМ ОЧЕРЕДЬ, А НЕ ОТВЕТ ПРЯМО ИЗ ВЕБХУКА. VPS в РФ не может достучаться
// напрямую до graph.instagram.com на отправку — входящие вебхуки принимаются,
// а ответ уходит из отдельного процесса ("движка"), у которого есть выход наружу
// (через ig-relay). Поэтому приёмник вебхука только складывает событие, а движок
// (обычно демон вне вебхука) его забирает и отвечает.
//
// Отличие от исходного проекта: путь к файлу — параметр фабрики, а не process.env,
// чтобы один процесс мог держать несколько независимых очередей (по инстансу бота)
// и чтобы тесты не трогали переменные окружения.

import fs from "node:fs";
import path from "node:path";

/** Сколько событий держим (запас на случай, если движок молчал долго). */
const ПРЕДЕЛ = 1000;
/** Порог обрезки в байтах. */
const ПОРОГ_ОБРЕЗКИ = 512 * 1024;

/**
 * @typedef {object} СобытиеIG
 * @property {string} id - comment_id или message_id, по нему движок отсекает повторы
 * @property {"комментарий"|"директ"} вид
 * @property {string} текст
 * @property {string} отId
 * @property {string} [отИмя]
 * @property {string} когда
 * @property {string} [пост] - для комментария: публикация, под которой он оставлен
 * @property {string} принято - когда положили в очередь
 */

/**
 * Создаёт очередь, привязанную к конкретному jsonl-файлу.
 * @param {string} файл абсолютный путь к jsonl-файлу очереди
 */
export function createIgQueue(файл) {
  if (!файл) throw new TypeError("createIgQueue: нужен путь к файлу очереди");

  function читать() {
    if (!fs.existsSync(файл)) return [];
    return fs
      .readFileSync(файл, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((с) => {
        try {
          return JSON.parse(с);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** Кладёт событие в очередь дозаписью; дедупликация — при чтении. */
  function положить(с) {
    fs.mkdirSync(path.dirname(файл), { recursive: true });
    fs.appendFileSync(файл, JSON.stringify(с) + "\n", "utf8");

    if (fs.statSync(файл).size > ПОРОГ_ОБРЕЗКИ) {
      const хвост = взять().slice(-ПРЕДЕЛ);
      fs.writeFileSync(файл, хвост.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
    }
  }

  /** Всё, что накопилось, без дублей: свежая запись побеждает старую. */
  function взять() {
    const по = new Map();
    for (const с of читать()) по.set(с.id, с);
    return [...по.values()];
  }

  /** Убирает обработанные по списку id. Возвращает число убранных. */
  function убрать(ids) {
    const набор = new Set(ids);
    const было = читать();
    const стало = было.filter((с) => !набор.has(с.id));
    fs.mkdirSync(path.dirname(файл), { recursive: true });
    fs.writeFileSync(файл, стало.map((x) => JSON.stringify(x)).join("\n") + (стало.length ? "\n" : ""), "utf8");
    return было.length - стало.length;
  }

  return { положить, взять, убрать, файл };
}
