#!/usr/bin/env node
// Вторая половина резервной копии: вынести зашифрованный архив с сервера и сказать людям,
// если копия не получилась. Зовётся из ops/backup.sh.
//
//   node ops/backup-upload.mjs <файл архива>      выгрузить архив в приватный бакет
//   node ops/backup-upload.mjs --alert "причина"  копия не сделана: тревога в рабочую группу
//
// ЗАЧЕМ ВЫНОСИТЬ. Архив на том же диске, что и данные, спасает от ошибочной команды, но
// не от потери сервера. Вторая копия уходит в ПРИВАТНЫЙ бакет объектного хранилища в
// России: в архиве лежат заявки, за границу и на компьютер оператора он не уезжает.
//
// Это ОТДЕЛЬНЫЙ бакет, не тот, из которого площадки забирают ролики: тот открыт на чтение
// всему интернету. Ключи бакета копий лежат только на сервере (BACKUP_S3_*).
// Бакет не настроен — архив остаётся только на сервере, и скрипт говорит об этом в журнал.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { env, has } from "../src/lib/env.mjs";
import { alert, resolve } from "../src/lib/notify.mjs";
import { putObject } from "../src/lib/s3.mjs";

const stamp = () => new Date().toISOString();
const args = process.argv.slice(2);

async function main() {
  if (args[0] === "--alert") {
    const why = String(args[1] || "причина не названа").slice(0, 300);
    console.error(`${stamp()} копия не сделана: ${why}`);
    await alert("backup:failed", `Резервная копия данных завода не сделана: ${why}.`, { action: "перешлите это сообщение оператору: без копии потеря сервера означает потерю заявок и журналов" });
    return 2;
  }
  const file = args[0];
  if (!file) { console.error("какой файл выгружать: node ops/backup-upload.mjs <файл архива>"); return 2; }
  const size = statSync(file).size;
  if (size < 200) {
    await alert("backup:failed", "Резервная копия данных завода получилась пустой.", { action: "перешлите это сообщение оператору" });
    return 2;
  }
  resolve("backup:failed");

  const needed = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY", "BACKUP_S3_SECRET_KEY"];
  if (!needed.every(has)) {
    console.log(`${stamp()} бакет копий не настроен (${needed.filter((n) => !has(n)).join(", ")}): архив остался только на сервере`);
    return 0;
  }
  const res = await putObject({
    endpoint: env("BACKUP_S3_ENDPOINT"),
    bucket: env("BACKUP_S3_BUCKET"),
    key: `zavod/${path.basename(file)}`,
    body: readFileSync(file),
    contentType: "application/octet-stream",
    accessKey: env("BACKUP_S3_ACCESS_KEY"),
    secretKey: env("BACKUP_S3_SECRET_KEY"),
    region: env("BACKUP_S3_REGION", "ru-1"),
    acl: "private",
  });
  if (!res.ok) {
    console.error(`${stamp()} архив не выгружен: ${res.error}`);
    await alert("backup:upload", `Резервная копия сделана, но не выгружена в хранилище: ${res.error}. Сейчас она лежит только на самом сервере.`, { action: "перешлите это сообщение оператору" });
    return 1;
  }
  resolve("backup:upload");
  console.log(`${stamp()} архив выгружен в бакет копий: ${Math.round(size / 1024)} КБ`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`${stamp()} сбой выгрузки копии: ${e?.stack || e}`); process.exitCode = 2; });
