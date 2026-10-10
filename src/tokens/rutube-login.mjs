#!/usr/bin/env node
// Ключ Rutube по логину и паролю аккаунта. Пароль вводит ВЛАДЕЛЕЦ АККАУНТА сам.
//
//   node src/tokens/rutube-login.mjs            спросит логин и пароль, сохранит ключ
//   node src/tokens/rutube-login.mjs --check    что с ключом и как сейчас выходят ролики
//
// ПАРОЛЬ НЕ ПЕРЕДАЁТСЯ И НЕ ХРАНИТСЯ. Rutube выдаёт ключ только в обмен на логин и
// пароль. Поэтому команду запускает владелец аккаунта: на созвоне он вводит пароль сам,
// ввод на экране не отображается, в файл окружения ложится только ключ. Оператор пароль
// не видит и не знает. Если владелец не готов вводить пароль на чужой машине, он
// запускает эту же команду у себя и передаёт только строку RUTUBE_TOKEN.
//
// СТАТУС: адрес выдачи ключа взят из официального клиента Rutube 2021 года и отвечает.
// Годится ли он для аккаунта со входом по номеру телефона, не подтверждено. Не выдал
// ключ — пишем в help@rutube.ru, а ролики тем временем идут пакетом на ручную загрузку.

import { createInterface } from "node:readline";
import { env } from "../lib/env.mjs";
import { setEnv } from "../lib/envfile.mjs";
import { json, request } from "../lib/http.mjs";

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Ввод пароля не печатается: вместо знаков выводится пустота.
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(question); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(answer.trim()); });
  });
}

let code = 1;
if (process.argv.includes("--check")) {
  const { probe } = await import("../channels/rutube.mjs");
  const p = await probe();
  console.log(p.kind === "ok" ? `✓ ${p.detail}` : `✗ ${p.error}`);
  code = p.kind === "ok" ? 0 : 1;
} else {
  console.log("Ключ Rutube. Логин и пароль вводит владелец аккаунта; пароль на экране не виден и никуда не сохраняется.\n");
  const username = await ask("Логин (почта или телефон): ");
  const password = await ask("Пароль: ", true);
  const r = await request("https://rutube.ru/api/accounts/token_auth/", json({ username, password }, { accept: "application/json" }));
  if (r.kind === "ok" && r.data?.token) {
    const file = setEnv({ RUTUBE_TOKEN: r.data.token });
    console.log(`✓ ключ сохранён в ${file} (RUTUBE_TOKEN). Перенесите эту строку на сервер тем же способом, что остальные ключи.`);
    console.log("Право загрузки проверит первый ролик: одна тестовая запись через очередь, под присмотром.");
    code = 0;
  } else {
    console.error(`✗ Rutube ключ не выдал: ${r.error || "ответ без ключа"}.`);
    console.error("Если вход в аккаунт идёт по номеру телефона или через VK ID, этот способ может не работать: письмо в help@rutube.ru с просьбой открыть загрузку через API.");
    code = r.kind === "network" ? 2 : 1;
  }
}
process.exitCode = code;
