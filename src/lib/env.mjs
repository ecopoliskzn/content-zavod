// Окружение: ключи и пути. Один вход на весь проект.
//
// ПРАВИЛА (каждое стоило нам потерянного дня в прошлых проектах):
//  · значения ключей не печатаются никогда, даже частично: в журнал идёт только имя
//    переменной и, если нужно сверить копии, отпечаток (fingerprint);
//  · файл с ключами один на машину: на компьютере оператора `.env.local` в корне
//    проекта, на сервере `/opt/ecopolis-data/.env` (рядом с данными, а не с кодом:
//    выкладка кода его не трогает, а продление маркеров может его переписать).
//    В git не попадает ни один;
//  · забытая переменная должна быть видна сразу: need() падает с именем переменной,
//    а не отдаёт пустую строку, из-за которой запрос молча уходит без ключа.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Где искать файл окружения. Первый найденный побеждает, остальные не читаются. */
const CANDIDATES = [
  process.env.ZAVOD_ENV_FILE,
  path.join(process.cwd(), ".env.local"),
  path.join(ROOT, ".env.local"),
  "/opt/ecopolis-data/.env",
  "/opt/ecopolis-zavod/.env",
].filter(Boolean);

let loaded = null;
let loadedFrom = "";
let loadedMtime = 0;
let checkedAt = 0;
const RECHECK_MS = 30_000;

function parse(text) {
  const out = {};
  for (const line of String(text).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/*
 * Файл перечитывается, если изменился: сервер живёт неделями, а маркеры Instagram и
 * Threads продлевает отдельный процесс (cron). Без перечитывания сервер держал бы в
 * памяти старый маркер до перезапуска. Проверка времени правки не чаще раза в полминуты.
 */
function load() {
  const now = Date.now();
  if (loaded && now - checkedAt < RECHECK_MS) return loaded;
  checkedAt = now;
  if (loaded && loadedFrom) {
    try { if (statSync(loadedFrom).mtimeMs === loadedMtime) return loaded; } catch { return loaded; }
  } else if (loaded) {
    // Файла не было: смотрим, не появился ли.
    if (!CANDIDATES.some((f) => existsSync(f))) return loaded;
  }
  loaded = {};
  loadedFrom = "";
  for (const file of CANDIDATES) {
    if (!existsSync(file)) continue;
    loaded = parse(readFileSync(file, "utf8"));
    loadedFrom = file;
    try { loadedMtime = statSync(file).mtimeMs; } catch { loadedMtime = 0; }
    break;
  }
  return loaded;
}

/** Значение переменной: сначала окружение процесса, потом файл. Нет — пустая строка. */
export function env(name, fallback = "") {
  const v = process.env[name] ?? load()[name];
  return v === undefined || v === "" ? fallback : String(v);
}

/** Обязательная переменная. Нет — исключение с ИМЕНЕМ (значение не называем никогда). */
export function need(name) {
  const v = env(name);
  if (!v) {
    const err = new Error(`нет переменной ${name} (файл окружения: ${loadedFrom || "не найден"})`);
    err.code = "ENV";
    throw err;
  }
  return v;
}

export const has = (name) => Boolean(env(name));

/** Короткий отпечаток значения: сверить две копии ключа, не показывая сам ключ. */
export function fingerprint(name) {
  const v = env(name);
  return v ? createHash("sha256").update(v).digest("hex").slice(0, 8) : "";
}

/** Число из окружения с запасным значением. */
export function num(name, fallback) {
  const v = Number(env(name));
  return Number.isFinite(v) && env(name) !== "" ? v : fallback;
}

/** Список через запятую. */
export function list(name) {
  return env(name).split(",").map((s) => s.trim()).filter(Boolean);
}

/** Откуда прочитан файл окружения (для doctor). */
export function envFile() {
  load();
  return loadedFrom;
}

/** Корень проекта и каталог данных. Данные лежат отдельно от кода и переживают выкладку. */
export const PROJECT_ROOT = ROOT;
export function dataDir() {
  return path.resolve(env("DATA_DIR", path.join(ROOT, "data")));
}
export const dataPath = (...parts) => path.join(dataDir(), ...parts);

/** Для тестов: сбросить кеш файла окружения. */
export function _reset() {
  loaded = null;
  loadedFrom = "";
  loadedMtime = 0;
  checkedAt = 0;
}
