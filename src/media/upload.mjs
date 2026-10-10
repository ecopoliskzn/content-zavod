#!/usr/bin/env node
// Файл с диска → публичный адрес в объектном хранилище. Запускается на компьютере
// оператора, где лежит ролик или картинка.
//
//   npm run media -- --file=D:/video/priemka-9x16.mp4
//   npm run media -- --file=D:/img/cover.jpg --key=covers/2026-10/priemka.jpg
//   npm run media -- --file=… --for=instagram     заодно проверить требования площадки
//
// Печатает адрес, который кладётся в поле media[].url записи очереди.
//
// ПОЧЕМУ НЕ С САЙТА. Instagram и Threads забирают файл сами и с сайтов в России его не
// берут («Media download has failed»). Из публичного объектного хранилища берут. Telegram
// наоборот: до российского хранилища не дотягивается, поэтому адаптер Telegram сам
// скачивает файл и отправляет байтами.
//
// ПРОВЕРКИ ДО ЗАГРУЗКИ. Ролик, который площадка отвергнет через десять минут обработки,
// дешевле отвергнуть здесь за секунду: расширение, размер, а при установленном ffprobe —
// ширина, длина и кодек. Исходник с телефона 2160×3840 Instagram не принимает: ширина
// видео там до 1920.
//
// Ключи хранилища на сервер не нужны вовсе: они лежат только на компьютере оператора.

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, need } from "../lib/env.mjs";
import { putObject } from "../lib/s3.mjs";

const TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".pdf": "application/pdf" };

/** Требования площадок к файлу. Числа из документации площадок на 10.2026. */
export const LIMITS = {
  instagram: { maxMb: 300, maxWidth: 1920, minSec: 3, maxSec: 900, ext: [".mp4", ".mov"], note: "MP4 или MOV, H.264/HEVC, звук AAC, ширина до 1920" },
  threads: { maxMb: 8, ext: [".jpg", ".jpeg", ".png"], note: "картинка JPEG или PNG до 8 МБ; видео в Threads не ставим" },
  telegram: { maxMb: 50, ext: [".mp4", ".jpg", ".jpeg", ".png"], note: "через облачный Bot API до 50 МБ" },
  rutube: { maxMb: 10240, ext: [".mp4", ".mov"], note: "файл Rutube забирает сам по адресу" },
  vk: { maxMb: 5120, ext: [".mp4", ".mov", ".jpg", ".jpeg", ".png"], note: "видео уходит по адресу загрузки, выданному ВКонтакте" },
};

/** Сведения о ролике через ffprobe, если он установлен. Нет ffprobe — null, это не ошибка. */
export function probeVideo(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name,pix_fmt,color_transfer:stream_side_data=rotation:format=duration", "-of", "json", file], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  try {
    const data = JSON.parse(r.stdout);
    const s = data.streams?.[0] || {};
    const rotation = Math.abs(Number(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0));
    // Телефон пишет 1920×1080 с пометкой поворота: настоящая ширина — меньшая сторона.
    const [width, height] = rotation === 90 || rotation === 270 ? [s.height, s.width] : [s.width, s.height];
    return { width, height, codec: s.codec_name || "", seconds: Number(data.format?.duration) || 0, hdr: /smpte2084|arib-std-b67/.test(s.color_transfer || "") };
  } catch {
    return null;
  }
}

/** Претензии к файлу под конкретную площадку. Чистая функция: сведения на вход. */
export function complaints(target, { ext, sizeMb, video }) {
  const lim = LIMITS[target];
  if (!lim) return [`площадки «${target}» нет в списке требований`];
  const bad = [];
  if (!lim.ext.includes(ext)) bad.push(`расширение ${ext}: площадка принимает ${lim.ext.join(", ")}`);
  if (sizeMb > lim.maxMb) bad.push(`размер ${sizeMb.toFixed(0)} МБ, предел ${lim.maxMb} МБ`);
  if (video) {
    if (lim.maxWidth && video.width > lim.maxWidth) bad.push(`ширина ${video.width}, предел ${lim.maxWidth}: сделайте копию 1080×1920`);
    if (lim.minSec && video.seconds && video.seconds < lim.minSec) bad.push(`длина ${video.seconds.toFixed(1)} с, меньше ${lim.minSec} с`);
    if (lim.maxSec && video.seconds > lim.maxSec) bad.push(`длина ${(video.seconds / 60).toFixed(1)} мин, больше ${lim.maxSec / 60} мин`);
    if (target === "instagram" && video.codec && !/h264|hevc|h265/.test(video.codec)) bad.push(`кодек ${video.codec}: нужен H.264 или HEVC`);
    if (video.hdr) bad.push("ролик в HDR: без перевода в обычный диапазон картинка на площадке выйдет тусклой");
  }
  return bad;
}

/** Имя объекта по умолчанию: раздел по месяцу, имя файла латиницей, хвост из отпечатка содержимого. */
export function defaultKey(file, bytes, now = new Date()) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file";
  const kind = ext === ".mp4" || ext === ".mov" ? "video" : ext === ".pdf" ? "files" : "img";
  return `${kind}/${now.toISOString().slice(0, 7)}/${base}-${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}${ext}`;
}

/** Загрузка файла. Возвращает { ok, url, key, error }. */
export async function uploadFile(file, { key, target } = {}) {
  if (!existsSync(file)) return { ok: false, error: `нет файла: ${file}` };
  const ext = path.extname(file).toLowerCase();
  if (!TYPES[ext]) return { ok: false, error: `расширение ${ext} не загружаем: ${Object.keys(TYPES).join(", ")}` };
  const sizeMb = statSync(file).size / 1048576;
  const video = ext === ".mp4" || ext === ".mov" ? probeVideo(file) : null;
  if (target) {
    const bad = complaints(target, { ext, sizeMb, video });
    if (bad.length) return { ok: false, error: `файл не подходит площадке ${target}: ${bad.join("; ")}` };
  }
  const bytes = readFileSync(file);
  const objectKey = key || defaultKey(file, bytes);
  const res = await putObject({
    endpoint: need("S3_ENDPOINT"),
    bucket: need("S3_BUCKET"),
    key: objectKey,
    body: bytes,
    contentType: TYPES[ext],
    accessKey: need("S3_ACCESS_KEY"),
    secretKey: need("S3_SECRET_KEY"),
    region: env("S3_REGION", "ru-1"),
    acl: env("S3_ACL", "public-read"),
    cacheControl: "public, max-age=31536000, immutable",
  });
  if (!res.ok) return { ok: false, error: `хранилище не приняло файл (${res.status}): ${res.error}` };
  const base = env("S3_PUBLIC_BASE") || `${need("S3_ENDPOINT").replace(/\/+$/, "")}/${need("S3_BUCKET")}`;
  const url = `${base.replace(/\/+$/, "")}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  // Загружено ещё не значит доступно: бакет мог остаться закрытым. Проверяем чужими глазами.
  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(20_000) });
    if (!head.ok) return { ok: false, url, key: objectKey, error: `файл загружен, но по публичному адресу отвечает ${head.status}: бакет закрыт для чтения` };
  } catch (e) {
    return { ok: false, url, key: objectKey, error: `файл загружен, публичный адрес не проверен: ${e?.message || e}` };
  }
  return { ok: true, url, key: objectKey, sizeMb, video, ffprobe: video !== null || !(ext === ".mp4" || ext === ".mov") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
  const file = opt("file");
  if (!file) {
    console.error("что загрузить: --file=<путь> [--key=<имя в хранилище>] [--for=instagram|threads|telegram|rutube|vk]");
    process.exitCode = 1;
  } else {
    try {
      const res = await uploadFile(file, { key: opt("key") || undefined, target: opt("for") || undefined });
      if (res.ok) {
        console.log(res.url);
        if (res.video) console.error(`ролик ${res.video.width}×${res.video.height}, ${res.video.seconds.toFixed(0)} с, кодек ${res.video.codec}, ${res.sizeMb.toFixed(0)} МБ`);
        else if (!res.ffprobe) console.error("ffprobe не найден: ширина и длина ролика не проверены. Поставьте ffmpeg, чтобы проверка работала");
      } else {
        console.error(`✗ ${res.error}`);
        process.exitCode = 1;
      }
    } catch (e) {
      console.error(`✗ ${e?.message || e}`);
      process.exitCode = e?.code === "ENV" ? 2 : 1;
    }
  }
}
