import test from "node:test";
import assert from "node:assert/strict";
import { parseEntry, botLink } from "../src/telegram/entry.mjs";

// Материалы-фикстура (нейтральные, не боевые тексты исходный проект).
const MATERIALS = [
  { key: "forbes", intro: "Держи подборку статей." },
  { key: "kpmg", intro: "Держи таблицу." },
];
// Как в исходный проект: materialByEntry сам режет метку по первому дефису (канал-материал),
// сюда приходит и полный ключ, и уже маршрут без IGSID-хвоста.
const materialByEntry = (key) => {
  const k = String(key).toLowerCase();
  const tail = k.includes("-") ? k.slice(k.indexOf("-") + 1) : k;
  return MATERIALS.find((m) => m.key === tail) || MATERIALS.find((m) => m.key === k);
};

test("голое /start без метки — общий вход", () => {
  assert.equal(parseEntry("/start")?.key, "direct");
});

test("простая метка площадки распознаётся", () => {
  const e = parseEntry("/start ig-test", { materialByEntry });
  assert.equal(e.key, "ig-test");
  assert.equal(e.канал, "ig");
});

test("неизвестная метка не роняет вход, а запоминается", () => {
  const e = parseEntry("/start что-то-новое");
  assert.ok(e, "вход потерян");
  assert.equal(e.key, "что-то-новое");
});

test("метка с материалом отдаёт материал, а не общий вход", () => {
  for (const key of ["yt-forbes", "ig-forbes"]) {
    const e = parseEntry(`/start ${key}`, { materialByEntry });
    assert.equal(e?.material, "forbes", `${key} не привёл к материалу`);
  }
});

test("голое имя материала работает как метка входа", () => {
  assert.equal(parseEntry("KPMG", { materialByEntry })?.material, "kpmg");
  assert.equal(parseEntry("kpmg", { materialByEntry })?.material, "kpmg");
  assert.equal(parseEntry("forbes", { materialByEntry })?.material, "forbes");
  assert.equal(parseEntry("/start kpmg", { materialByEntry })?.material, "kpmg");
  // Живая фраза материалом не становится: принимается только точное совпадение.
  assert.equal(parseEntry("а что вы думаете про kpmg", { materialByEntry }), null);
});

test("обычный текст меткой входа не считается", () => {
  assert.equal(parseEntry("привет"), null);
  assert.equal(parseEntry("расскажи что-нибудь"), null);
});

test("персональная метка (IGSID-хвост) ведёт туда же, что обычная, но key сохраняет хвост", () => {
  const IGSID = "-29245176808405808";
  const обычная = parseEntry("/start ig-test");
  const личная = parseEntry(`/start ig-test${IGSID}`);
  assert.equal(личная.канал, обычная.канал);
  assert.equal(личная.key, `ig-test${IGSID}`, "полная метка обязана сохраниться для атрибуции");
});

test("метка на материал из поста разбирается в чистый ключ, без «/start »", () => {
  for (const метка of ["gr-test", "tg-test", "th-test"]) {
    assert.equal(parseEntry(`/start ${метка}`)?.key, метка);
  }
});

test("ссылка входа в бота собирается с меткой", () => {
  assert.equal(botLink("mybot", "channel-pin"), "https://t.me/mybot?start=channel-pin");
});

test("суффикс канала «--site» отдаёт материал и канал site, суффикс отрезан от поиска", () => {
  const e = parseEntry("/start forbes--site", { materialByEntry });
  assert.equal(e.material, "forbes");
  assert.equal(e.канал, "site");
  assert.equal(e.key, "forbes--site", "полная метка с суффиксом сохраняется целиком");
});

test("суффикс «--site» не путается с ключом материала на одиночном дефисе", () => {
  const MATERIALS_HYPHEN = [{ key: "rol-hr", intro: "Роль HR." }];
  const lookup = (key) => {
    const k = String(key).toLowerCase();
    const tail = k.includes("-") ? k.slice(k.indexOf("-") + 1) : k;
    return MATERIALS_HYPHEN.find((m) => m.key === tail) || MATERIALS_HYPHEN.find((m) => m.key === k);
  };
  const e = parseEntry("/start rol-hr--site", { materialByEntry: lookup });
  assert.equal(e.material, "rol-hr");
  assert.equal(e.канал, "site");
});

test("персональная метка (IGSID-хвост) не путается с суффиксом канала", () => {
  const e = parseEntry("/start forbes-29245176808405808", { materialByEntry });
  assert.equal(e.material, "forbes");
  assert.equal(e.канал, undefined, "IGSID-хвост не должен давать канал по карте суффиксов");
});

test("настраиваемая карта суффиксов канала (инстанс может добавить свой)", () => {
  const custom = (key) => (String(key).toLowerCase() === "forbes" ? { key: "forbes" } : undefined);
  const e = parseEntry("/start forbes~~app", {
    materialByEntry: custom,
    суффиксыКаналов: { "~~app": "app" },
  });
  assert.equal(e.material, "forbes");
  assert.equal(e.канал, "app");
});

test("настраиваемый список платформ (инстанс может сузить/расширить набор)", () => {
  const e = parseEntry("/start custom-slug", { платформы: ["custom"] });
  assert.equal(e.канал, "custom");
  const нет = parseEntry("/start ig-slug", { платформы: ["custom"] });
  // "ig" больше не входит в список площадок инстанса — считается неизвестной меткой без канала
  assert.equal(нет.key, "ig-slug");
  assert.equal(нет.канал, undefined);
});

test("суффикс канала «--threads» отдаёт материал и канал threads (переходы из Threads)", () => {
  const e = parseEntry("/start forbes--threads", { materialByEntry });
  assert.equal(e.material, "forbes");
  assert.equal(e.канал, "threads");
  assert.equal(e.key, "forbes--threads");
});
