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
  ensureDir(file);
  appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  return row;
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}

export function writeAtomic(file, content) {
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
