// Файлы состояния: журналы только на дописывание, замена файла только атомарно.
//
// ЖУРНАЛ ДОПИСЫВАЕТСЯ, А НЕ ПЕРЕСОБИРАЕТСЯ. Любой пересбор файла целиком рано или поздно
// затирает чужую строку: два процесса читают одну версию, каждый пишет свою. В журнале
// (.jsonl) по номеру записи побеждает последняя строка, история остаётся видна.
//
// ЗАМЕНА АТОМАРНА. Запись во временный файл и rename: читатель никогда не увидит
// половину JSON. Важно: rename поверх одиночного bind-mount файла в Docker подменяет
// его только внутри контейнера (так у нас терялся продлённый токен). Файлы состояния
// монтируются каталогом, не поштучно.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, wrongUser } from "./env.mjs";

/*
 * ЗАПИСЬ В КАТАЛОГ ДАННЫХ ТОЛЬКО ПОД ПОЛЬЗОВАТЕЛЕМ ЗАВОДА. Команда, запущенная под root,
 * оставляет в каталоге данных файлы, которые завод потом не может ни прочитать, ни
 * дописать: бот молчит, расписание не пишет очередь, сбор цифр падает на первой строке.
 * Заслон стоит здесь, в самой записи, а не в отдельных командах: задач в расписании
 * полтора десятка, и защищать их по одной значит однажды забыть новую.
 */
let foreign = null;
function guard(file) {
  if (foreign === null) foreign = wrongUser();
  if (!foreign) return;
  // Каталог сверяется целиком, а не по началу строки: соседний «…-data-old» заслон не задевает.
  const dir = dataDir();
  const full = path.resolve(file);
  if (full === dir || full.startsWith(dir + path.sep)) throw Object.assign(new Error(foreign), { code: "ENV" });
}

/** Для тестов: подставить ответ «не тот пользователь»; null возвращает настоящую проверку. */
export function _setForeign(message) { foreign = message; }

export function ensureDir(file) {
  mkdirSync(path.dirname(file), { recursive: true });
}

/** Все строки журнала. Битая строка пропускается: одна поломка не роняет весь файл. */
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* пропускаем */ }
  }
  return out;
}

/** Последняя версия каждой записи по полю id. */
export function latestById(file, key = "id") {
  const map = new Map();
  for (const row of readJsonl(file)) if (row && row[key] != null) map.set(String(row[key]), row);
  return map;
}

export function appendJsonl(file, row) {
  guard(file);
  ensureDir(file);
  appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  return row;
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}

export function writeAtomic(file, content) {
  guard(file);
  ensureDir(file);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

export const writeJson = (file, data) => writeAtomic(file, JSON.stringify(data, null, 1) + "\n");

/**
 * Замок одним файлом. Протухший (старше staleMs) перехватывается: проход длится минуты,
 * замок такого возраста означает упавший процесс. Возвращает функцию снятия или null.
 */
export function lock(file, staleMs = 20 * 60_000) {
  guard(file);
  ensureDir(file);
  try {
    writeFileSync(file, `${process.pid} ${new Date().toISOString()}`, { flag: "wx" });
  } catch {
    try {
      if (Date.now() - statSync(file).mtimeMs < staleMs) return null;
      unlinkSync(file);
      writeFileSync(file, `${process.pid} ${new Date().toISOString()}`, { flag: "wx" });
    } catch { return null; }
  }
  return () => { try { unlinkSync(file); } catch { /* уже снят */ } };
}
