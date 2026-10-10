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

/*
 * Где искать файл окружения. Первый найденный побеждает, остальные не читаются.
 *
 * ФАЙЛ, НАЗВАННЫЙ ЯВНО (ZAVOD_ENV_FILE), ЕДИНСТВЕННЫЙ. Нет его — окружение пустое, и дальше
 * по списку загрузчик не идёт. Раньше шёл: тесты называют несуществующий файл, чтобы
 * отгородиться от настоящих ключей, а на компьютере оператора загрузчик молча брал его
 * боевой `.env.local`. С адресом сервера оттуда тесты выпуска работали бы как дубль
 * расписания, а запись ключа из теста попала бы в боевой файл.
 */
const EXPLICIT = process.env.ZAVOD_ENV_FILE || "";
const CANDIDATES = EXPLICIT
  ? [EXPLICIT]
  : [path.join(process.cwd(), ".env.local"), path.join(ROOT, ".env.local"), "/opt/ecopolis-data/.env", "/opt/ecopolis-zavod/.env"];

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

/** Куда записывать ключи: файл, названный явно; иначе прочитанный; иначе `.env.local` в корне проекта. */
export function envTarget() {
  load();
  return EXPLICIT || loadedFrom || path.join(ROOT, ".env.local");
}

/** Корень проекта и каталог данных. Данные лежат отдельно от кода и переживают выкладку. */
export const PROJECT_ROOT = ROOT;
export function dataDir() {
  return path.resolve(env("DATA_DIR", path.join(ROOT, "data")));
}
export const dataPath = (...parts) => path.join(dataDir(), ...parts);

/**
 * Не под тем ли пользователем запущена команда. На сервере завод живёт под своим
 * пользователем. Команда, запущенная под root, оставляет в каталоге данных файлы, которые
 * завод потом не может прочитать: сервис падает на старте, а расписание молча не пишет
 * очередь. У нас так однажды переписали файл окружения, и бот замолчал до утра.
 * @returns {string} пустая строка, если всё в порядке; иначе что сделать
 */
export function wrongUser() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return "";
  try {
    return statSync(dataDir()).uid !== 0 ? "команда запущена под root, а каталог данных принадлежит пользователю завода: созданные файлы завод не прочитает. Запустите её под пользователем завода (ssh zavod@<сервер> либо sudo -u zavod <команда>)" : "";
  } catch {
    return "";
  }
}

/** Для тестов: сбросить кеш файла окружения. */
export function _reset() {
  loaded = null;
  loadedFrom = "";
  loadedMtime = 0;
  checkedAt = 0;
}
