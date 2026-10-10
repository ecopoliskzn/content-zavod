#!/usr/bin/env node
// Вход владельца аккаунта в Instagram и Threads: ссылка, обмен кода на маркер, запись маркера.
// Запускается НА КОМПЬЮТЕРЕ ОПЕРАТОРА: с сервера в России адреса Meta для обмена кода
// не отвечают, а секрет приложения первого месяца на сервер клиента класть нельзя.
//
//   node src/tokens/meta-login.mjs --platform=instagram --url          шаг 1: ссылка для входа
//   node src/tokens/meta-login.mjs --platform=instagram --code=<код>   шаг 2: обменять код на маркер
//   node src/tokens/meta-login.mjs --platform=threads --url
//   node src/tokens/meta-login.mjs --platform=threads --code=<код>
//   node src/tokens/meta-login.mjs --platform=threads --paste          маркер из генератора в консоли Meta
//   node src/tokens/meta-login.mjs --platform=instagram --check        чей маркер и жив ли он
//
// КАК ПРОХОДИТ ВХОД.
//  1. Аккаунт клиента добавлен тестировщиком в приложение Meta, и владелец принял приглашение.
//  2. Команда --url печатает ссылку. Владелец открывает её НА СВОЁМ ТЕЛЕФОНЕ, входит своим
//     аккаунтом и нажимает «Разрешить». Со своего устройства в аккаунт клиента мы не входим:
//     вход с чужого устройства площадка считает взломом и сбрасывает все сеансы владельца.
//  3. Его перебрасывает на страницу возврата с кодом. Код живёт час и годится один раз.
//  4. Команда --code меняет код на короткий маркер, короткий на маркер на 60 дней, спрашивает
//     у площадки имя и номер аккаунта и пишет всё в файл окружения. Значение не печатается.
//  5. Маркер переносится на сервер файлом: npm run tokens -- --export=… и --import на сервере.
//
// ЧЬЁ ПРИЛОЖЕНИЕ. Первый месяц это приложение исполнителя: его номер и секрет лежат только
// в .env.local на компьютере оператора (META_IG_*, META_THREADS_*). На сервер клиента они
// не попадают никогда: с секретом приложения можно подделать событие любого аккаунта в нём.
// После переезда на своё приложение клиента в тех же переменных лежат его номер и секрет.
//
// ПРАВА БЕРУТСЯ СРАЗУ ВСЕ. Задним числом право к маркеру не добавить: нужен новый вход.
//
// --paste для Threads. Если вход по ссылке не проходит, маркер выдаёт генератор в консоли
// Meta (приложение → Threads API → маркеры пользователя). Для него нужны пять условий
// разом: права в приложении, роль тестировщика, принятое приглашение, открытый профиль и
// живой сеанс на threads.com. Маркер вставляется в скрытую строку ввода: на экране и в
// истории команд его нет.
//
// СТАТУС. Порядок для Instagram проверен в наших проектах. Вход Threads по ссылке написан
// по документации Meta и боем у нас не проверен: в прошлом запуске маркер брали генератором.

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { env, need } from "../lib/env.mjs";
import { setEnv } from "../lib/envfile.mjs";
import { form, request } from "../lib/http.mjs";

const GRAPH = "v23.0";

export const PLATFORMS = {
  instagram: {
    title: "Instagram",
    appId: "META_IG_APP_ID",
    appSecret: "META_IG_APP_SECRET",
    redirect: "META_IG_REDIRECT_URI",
    authorize: "https://www.instagram.com/oauth/authorize",
    scopes: ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments", "instagram_business_manage_messages", "instagram_business_manage_insights"],
    keys: { token: "IG_TOKEN", id: "IG_USER_ID", name: "IG_USERNAME", expires: "IG_TOKEN_EXPIRES" },
    where: "Настройки → Сайты и приложения → Приглашения тестировщика",
  },
  threads: {
    title: "Threads",
    appId: "META_THREADS_APP_ID",
    appSecret: "META_THREADS_APP_SECRET",
    redirect: "META_THREADS_REDIRECT_URI",
    authorize: "https://threads.net/oauth/authorize",
    scopes: ["threads_basic", "threads_content_publish", "threads_manage_insights", "threads_manage_replies", "threads_read_replies"],
    keys: { token: "THREADS_TOKEN", id: "THREADS_USER_ID", name: "THREADS_USERNAME", expires: "THREADS_TOKEN_EXPIRES" },
    where: "Настройки → Аккаунт → Разрешения сайтов → Приглашения",
  },
};

/** Ссылка для входа владельца аккаунта. Чистая функция. */
export function authorizeUrl(platform, { appId, redirect }) {
  const p = PLATFORMS[platform];
  return `${p.authorize}?${new URLSearchParams({ client_id: appId, redirect_uri: redirect, response_type: "code", scope: p.scopes.join(",") })}`;
}

/** Код со страницы возврата: Instagram дописывает в конец «#_», люди копируют его вместе с пробелами. */
export const cleanCode = (code) => String(code || "").trim().replace(/#_$/, "");

/** Убирает секреты из текста ошибки: площадка иногда возвращает маркер в ответе об отказе. */
export function scrub(text, ...secrets) {
  let s = String(text ?? "");
  for (const secret of secrets) if (secret && String(secret).length >= 6) s = s.split(String(secret)).join("«скрыто»");
  return s.slice(0, 300);
}

/** Дата истечения из срока жизни в секундах: день по Москве, как его ведёт продление. */
export function expiresOn(seconds, now = Date.now()) {
  const life = Number(seconds) > 0 ? Number(seconds) : 60 * 86_400;
  return new Date(now + life * 1000 + 3 * 3600_000).toISOString().slice(0, 10);
}

const fail = (message, code = "RULE") => Object.assign(new Error(message), { code });

async function exchange(platform, code) {
  const p = PLATFORMS[platform];
  const appId = need(p.appId);
  const appSecret = need(p.appSecret);
  const redirect = need(p.redirect);
  const shortUrl = platform === "instagram" ? "https://api.instagram.com/oauth/access_token" : "https://graph.threads.net/oauth/access_token";
  const short = await request(shortUrl, form({ client_id: appId, client_secret: appSecret, grant_type: "authorization_code", redirect_uri: redirect, code: cleanCode(code) }));
  // Instagram отдаёт ответ то объектом, то списком из одного объекта.
  const shortToken = short.data?.access_token || short.data?.data?.[0]?.access_token;
  if (!shortToken) throw fail(`код не обменялся: ${scrub(short.error || "площадка не вернула маркер", appSecret)}. Код живёт час и годится один раз: повторите с шага --url`, short.kind === "network" ? "ENV" : "RULE");
  const longUrl = platform === "instagram"
    ? `https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: appSecret, access_token: shortToken })}`
    : `https://graph.threads.net/access_token?${new URLSearchParams({ grant_type: "th_exchange_token", client_secret: appSecret, access_token: shortToken })}`;
  const long = await request(longUrl);
  if (!long.data?.access_token) throw fail(`короткий маркер не обменялся на длинный: ${scrub(long.error, appSecret, shortToken)}`, long.kind === "network" ? "ENV" : "RULE");
  return { token: long.data.access_token, expires: expiresOn(long.data.expires_in) };
}

/** Кому принадлежит маркер. У Instagram нужен user_id: он же приходит в событиях. */
async function whoAmI(platform, token) {
  const url = platform === "instagram"
    ? `https://graph.instagram.com/${GRAPH}/me?${new URLSearchParams({ fields: "id,user_id,username,account_type", access_token: token })}`
    : `https://graph.threads.net/v1.0/me?${new URLSearchParams({ fields: "id,username", access_token: token })}`;
  const me = await request(url, { retries: 1, retryDelayMs: 5_000 });
  const id = platform === "instagram" ? me.data?.user_id : me.data?.id;
  if (me.kind !== "ok" || !id) throw fail(`маркер не отвечает: ${scrub(me.error || "площадка не назвала аккаунт", token)}`, me.kind === "network" ? "ENV" : "RULE");
  return { id: String(id), username: String(me.data.username || ""), type: me.data.account_type || "" };
}

function save(platform, { token, expires }, me) {
  const k = PLATFORMS[platform].keys;
  return setEnv({ [k.token]: token, [k.id]: me.id, [k.name]: me.username, [k.expires]: expires });
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(question); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()); });
  });
}

function next(platform) {
  const k = PLATFORMS[platform].keys;
  const names = Object.values(k).join(",");
  console.log("\nПеренос на сервер, без чата и буфера обмена:");
  console.log(`  npm run tokens -- --export=${names} --out=meta.env`);
  console.log("  scp meta.env zavod@<адрес сервера>:/tmp/meta.env");
  console.log("  на сервере: node src/tokens/check.mjs --import=/tmp/meta.env");
  console.log("  здесь: удалить meta.env");
  if (platform === "instagram") console.log("Приём на сервере сам оформит подписку аккаунта на события: без неё кодовые слова молчат.");
}

async function main() {
  const flag = (name) => process.argv.includes(`--${name}`);
  const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
  const platform = opt("platform");
  const p = PLATFORMS[platform];
  if (!p) throw fail("какая площадка: --platform=instagram либо --platform=threads");

  if (flag("url")) {
    const url = authorizeUrl(platform, { appId: need(p.appId), redirect: need(p.redirect) });
    console.log(`Ссылку открывает ВЛАДЕЛЕЦ АККАУНТА ${p.title} на своём телефоне, где он вошёл в аккаунт.`);
    console.log(`До этого он принял приглашение тестировщика: ${p.where}.\n`);
    console.log(url);
    console.log(`\nПосле «Разрешить» откроется страница ${env(p.redirect)} с кодом. Код живёт час и годится один раз.`);
    return 0;
  }

  if (opt("code")) {
    const issued = await exchange(platform, opt("code"));
    const me = await whoAmI(platform, issued.token);
    if (platform === "instagram" && me.type && !/BUSINESS|MEDIA_CREATOR|CREATOR/i.test(me.type)) console.error(`внимание: тип аккаунта «${me.type}». Публикация и события работают только у профессионального аккаунта`);
    const file = save(platform, issued, me);
    console.log(`✓ ${p.title}: маркер записан в ${file}. Аккаунт @${me.username}, номер ${me.id}, истекает ${issued.expires}.`);
    next(platform);
    return 0;
  }

  if (flag("paste")) {
    if (platform !== "threads") throw fail("--paste есть только у Threads: маркер Instagram выдаётся входом по ссылке");
    const token = await askHidden("Маркер из генератора (ввод не виден): ");
    if (token.length < 40) throw fail("это не похоже на маркер: строка слишком короткая");
    const me = await whoAmI(platform, token);
    // Генератор выдаёт маркер на 60 дней и срок не называет: считаем от сегодняшнего дня.
    const file = save(platform, { token, expires: expiresOn(60 * 86_400) }, me);
    console.log(`✓ Threads: маркер записан в ${file}. Аккаунт @${me.username}, номер ${me.id}. Срок посчитан как 60 дней от сегодня.`);
    next(platform);
    return 0;
  }

  if (flag("check")) {
    const token = env(p.keys.token);
    if (!token) throw fail(`маркера нет: ${p.keys.token} не задан`);
    const me = await whoAmI(platform, token);
    console.log(`✓ ${p.title}: @${me.username}, номер ${me.id}${me.type ? `, тип ${me.type}` : ""}, истекает ${env(p.keys.expires) || "срок не записан"}`);
    if (env(p.keys.id) && env(p.keys.id) !== me.id) { console.error(`✗ в файле окружения записан другой номер аккаунта (${p.keys.id}): маркер выдан не тому аккаунту`); return 1; }
    return 0;
  }

  throw fail("что сделать: --url | --code=<код> | --paste | --check");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Код выхода полем, без process.exit(): мгновенный выход после сетевого запроса на
  // свежих Node под Windows даёт ложный код 127 при сделанной работе.
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`✗ ${e?.message || e}`);
    process.exitCode = e?.code === "ENV" ? 2 : 1;
  });
}
