#!/usr/bin/env node
// Вход администратора сообщества ВКонтакте через VK ID: ключ для загрузки фото и видео.
// Запускается НА СЕРВЕРЕ: ключ обновления меняется при каждом обновлении, поэтому жить
// он должен в одном месте.
//
//   node src/tokens/vk-login.mjs --url                       шаг 1: напечатать ссылку для входа
//   node src/tokens/vk-login.mjs --code=<код> --device=<id>  шаг 2: обменять код на ключи
//   node src/tokens/vk-login.mjs --check                     чей ключ и что он умеет
//
// КАК ПРОХОДИТ ВХОД.
//  1. В кабинете VK ID (id.vk.ru/about/business) у компании создано приложение. В его
//     настройках указан доверенный адрес возврата: <адрес завода>/cb/vk. Номер приложения
//     лежит в VK_APP_ID.
//  2. Команда --url печатает ссылку. Администратор сообщества открывает её в браузере,
//     где он вошёл во ВКонтакте, и нажимает «Разрешить».
//  3. Его перебрасывает на страницу завода. На ней две строки: код и номер устройства.
//     Он пересылает их оператору. Код живёт десять минут и годится один раз.
//  4. Команда --code обменивает код на ключ доступа (живёт час) и ключ обновления.
//     Оба ложатся в файл окружения сервера. Значения не печатаются.
//
// СТАТУС: написано по документации VK ID на 10.10.2026, боем не проверено. Права wall,
// photos и video для приложения запрашиваются в поддержке ВКонтакте; без них вход пройдёт,
// а загрузка фото вернёт отказ. До этого записи с фото идут пакетом на ручную выкладку.

import { createHash, randomBytes } from "node:crypto";
import { dataPath, env, need } from "../lib/env.mjs";
import { setEnv } from "../lib/envfile.mjs";
import { readJson, writeJson } from "../lib/files.mjs";
import { form, request } from "../lib/http.mjs";

const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const PKCE = () => dataPath("vk-pkce.json");
const redirect = () => `${need("PUBLIC_BASE_URL").replace(/\/+$/, "")}/cb/vk`;

let code = 1;
try {
  if (flag("url")) {
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(18));
    // Проверочную строку храним до обмена кода: без неё код бесполезен.
    writeJson(PKCE(), { verifier, state, at: new Date().toISOString() });
    const url = `https://id.vk.ru/authorize?${new URLSearchParams({ response_type: "code", client_id: need("VK_APP_ID"), redirect_uri: redirect(), state, code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", scope: "wall photos video groups" })}`;
    console.log("Ссылку открывает АДМИНИСТРАТОР СООБЩЕСТВА в браузере, где он вошёл во ВКонтакте:\n");
    console.log(url);
    console.log(`\nПосле «Разрешить» откроется страница ${redirect()} с кодом и номером устройства. Код живёт 10 минут.`);
    code = 0;
  } else if (opt("code")) {
    const saved = readJson(PKCE());
    if (!saved) throw Object.assign(new Error("сначала шаг 1: --url. Проверочная строка для обмена кода не найдена"), { code: "RULE" });
    const r = await request("https://id.vk.ru/oauth2/auth", form({ grant_type: "authorization_code", code: opt("code"), code_verifier: saved.verifier, client_id: need("VK_APP_ID"), device_id: opt("device"), redirect_uri: redirect(), state: saved.state }));
    if (r.kind !== "ok" || !r.data?.access_token) throw Object.assign(new Error(`код не обменялся: ${r.error || "ВКонтакте не вернул ключ"}. Код мог истечь: повторите с шага 1`), { code: "RULE" });
    const file = setEnv({
      VK_USER_TOKEN: r.data.access_token,
      VK_USER_REFRESH_TOKEN: r.data.refresh_token || "",
      VK_DEVICE_ID: opt("device"),
      VK_USER_TOKEN_EXPIRES: new Date(Date.now() + (Number(r.data.expires_in) || 3600) * 1000).toISOString(),
    });
    writeJson(PKCE(), {});
    console.log(`✓ ключи администратора сохранены в ${file}. Выданные права: ${r.data.scope || "не названы"}`);
    if (!/wall/.test(String(r.data.scope || "")) || !/photos/.test(String(r.data.scope || ""))) console.log("⚠ среди прав нет wall или photos: приложению они не выданы. Запрос в поддержку ВКонтакте: devsupport@corp.vk.com");
    code = 0;
  } else if (flag("check")) {
    const { probe } = await import("../channels/vk.mjs");
    const p = await probe();
    console.log(p.kind === "ok" ? `✓ ${p.detail}` : `✗ ${p.error}`);
    console.log(env("VK_USER_TOKEN_EXPIRES") ? `ключ администратора действует до ${env("VK_USER_TOKEN_EXPIRES")}, обновляется сам` : "ключа администратора нет");
    code = p.kind === "ok" ? 0 : 1;
  } else {
    console.error("что сделать: --url | --code=<код> --device=<номер устройства> | --check");
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  code = e.code === "RULE" ? 1 : 2;
}
process.exitCode = code;
