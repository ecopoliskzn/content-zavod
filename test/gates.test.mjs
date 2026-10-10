// Проверки текста: готовность, речь, реклама, факты. Каждое правило — на живом примере.
import test from "node:test";
import assert from "node:assert/strict";
import { adlaw, checkAll, facts, numbersIn, opener, ready, speech } from "../src/gates/rules.mjs";

const thread = (posts, over = {}) => ({ channel: "threads", kind: "thread", name: "t", posts, ...over });
const post = (text, over = {}) => ({ channel: "telegram", kind: "post", name: "p", text, ...over });
const stamps = [{ phrase: "в современном мире" }, { phrase: "интересно, что" }];

test("готовность: пустой текст и заглушка останавливают", () => {
  assert.match(ready(post("")).block.join("|"), /текста нет/);
  assert.match(ready(post("Покрытие служит [здесь срок] лет")).block.join("|"), /заглушка/);
  assert.match(ready(post("Подробнее: <ССЫЛКА>")).block.join("|"), /заглушка/);
});

test("готовность: разметка Телеграма заглушкой не считается", () => {
  assert.deepEqual(ready(post("<b>Толщина</b> и <blockquote>цитата</blockquote>")).block, []);
});

test("готовность: счётчик, две ссылки и ссылка не в конце", () => {
  assert.match(ready(thread(["Начало 1/3", "хвост"])).block.join("|"), /счётчик/);
  assert.match(ready(thread(["a https://a.ru", "b https://b.ru"])).block.join("|"), /ссылок 2/);
  assert.match(ready(thread(["a https://a.ru", "b"])).block.join("|"), /не в последней/);
  assert.deepEqual(ready(thread(["a", "b https://a.ru"])).block, []);
});

test("речь: штамп ловится по границам слова с кириллицей", () => {
  assert.match(speech(post("В современном мире покрытия важны."), { stamps }).block.join("|"), /штамп/);
  // «неинтересно, что» штампом «интересно, что» не считается
  assert.deepEqual(speech(post("Ему неинтересно, что будет через год."), { stamps }).block, []);
});

test("речь: повтор начала прошлой записи останавливает", () => {
  const text = "Подрядчик сдал площадку, а через год она крошится.";
  const ctx = { recentOpeners: [{ opener: opener(text), name: "staraya" }] };
  assert.match(speech(thread([text, "хвост"]), ctx).block.join("|"), /повторяет запись «staraya»/);
  assert.deepEqual(speech(thread([text, "хвост"], { name: "staraya" }), ctx).block, []);
});

test("речь: хэштег, эмодзи и кодовое слово в Threads останавливают", () => {
  assert.match(speech(thread(["Толщина 10 мм #покрытие", "х"])).block.join("|"), /хэштег/);
  assert.match(speech(thread(["Толщина 10 мм 🙂", "х"])).block.join("|"), /эмодзи/);
  assert.match(speech(thread(["Толщина 10 мм", "Напишите ПРИЁМКА"]), { codeWords: ["ПРИЁМКА"] }).block.join("|"), /кодовое слово/);
  // слово «приёмка» строчными в обычном тексте кодовым не считается
  assert.deepEqual(speech(thread(["На приёмке в 2 случаях из 10 толщину не мерят", "х"]), { codeWords: ["ПРИЁМКА"] }).block, []);
});

test("речь: советы по зачину — вопрос, обращение, одиночный пост, нет якоря", () => {
  const w = speech(thread(["Как вы проверяете толщину покрытия?"])).warn.join("|");
  assert.match(w, /одиночный пост/);
  assert.match(w, /вопросом/);
  assert.match(w, /обращение/);
  assert.match(speech(thread(["покрытие бывает разным", "х"])).warn.join("|"), /нет якоря/);
  assert.doesNotMatch(speech(thread(["В Чебоксарах школа №30 сэкономила на покрытии", "х"])).warn.join("|"), /нет якоря/);
});

test("речь: превосходная степень даёт предупреждение со ссылкой на закон", () => {
  assert.match(speech(post("Мы единственные, кто так делает")).warn.join("|"), /превосходная степень/);
});

test("реклама: на площадке с ограниченным доступом цена, акция и призыв останавливают", () => {
  const r = { restricted: true };
  assert.match(adlaw(post("Укладка от 1000 ₽ за м²"), r).block.join("|"), /цена/);
  assert.match(adlaw(post("Укладка 1000 ₽ = 1 м²"), r).block.join("|"), /цена/);
  assert.match(adlaw(post("До конца месяца скидка на крошку"), r).block.join("|"), /скидка/);
  assert.match(adlaw(post("Закажите покрытие сейчас"), r).block.join("|"), /призыв/);
  assert.match(adlaw(post("Звоните: 8 (800) 700-86-52"), r).block.join("|"), /телефон/);
  assert.match(adlaw(post("Бесплатный замер за 36 часов"), r).block.join("|"), /бесплатная/);
});

test("реклама: рассказ без предложения проходит, «реакция» акцией не считается", () => {
  const r = { restricted: true };
  assert.deepEqual(adlaw(post("Школа сэкономила 700 000 рублей на ремонте стадиона."), r).block, []);
  assert.deepEqual(adlaw(post("Реакция подрядчика была предсказуемой."), r).block, []);
  assert.deepEqual(adlaw(post("Покупатель хотел заказать покрытие у другого подрядчика."), r).block, []);
  assert.match(adlaw(post("Покупатель хотел заказать покрытие у другого подрядчика."), r).warn.join("|"), /заказать/);
});

test("реклама: на открытой площадке то же самое только предупреждение", () => {
  const out = adlaw(post("Укладка от 1000 ₽ за м²", { channel: "vk" }), { restricted: false });
  assert.deepEqual(out.block, []);
  assert.match(out.warn.join("|"), /Площадка открытая/);
});

test("факты: числа, которым нужен источник", () => {
  assert.deepEqual(numbersIn("Толщина 10 мм, расход 7,5 кг, площадь 1 200 м²"), ["10", "7,5", "1 200"]);
});

test("факты: годы, время, даты, номера документов и пункты списка пропускаются", () => {
  assert.deepEqual(numbersIn("В 2024 году, 15 октября в 19:30, по ТР ЕАЭС 042/2017 и 44-ФЗ, приказ №1134, ГОСТ Р 52169-2012"), []);
  assert.deepEqual(numbersIn("1. Основание\n2. Клей\n5 ошибок укладки"), []);
  assert.deepEqual(numbersIn("5 мм зазора"), ["5"]);
});

test("факты: цифра без источника останавливает, с источником проходит", () => {
  const e = post("Толщина покрытия 10 мм, служит больше 10 лет.");
  assert.match(facts(e).block.join("|"), /цифры без источника/);
  const ok = { ...e, facts: [{ claim: "толщина от 10 мм", source: "https://ecopolisrf.ru/" }] };
  assert.deepEqual(facts(ok).block, []);
  const noSource = { ...e, facts: [{ claim: "толщина от 10 мм" }] };
  assert.match(facts(noSource).block.join("|"), /не указан источник/);
});

test("checkAll собирает претензии всех проверок", () => {
  const out = checkAll(thread(["В современном мире покрытие стоит от 1000 ₽ за м² #топ"]), { stamps, restricted: true });
  const all = out.block.join("|");
  assert.match(all, /штамп/);
  assert.match(all, /реклама/);
  assert.match(all, /хэштег/);
  assert.match(all, /факты/);
});
