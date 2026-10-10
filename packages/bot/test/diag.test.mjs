import test from "node:test";
import assert from "node:assert/strict";
import { createDiagEngine } from "../src/telegram/diag.mjs";

function fixture() {
  return createDiagEngine({
    questions: [
      { id: "q1", text: "Вопрос 1", options: [{ text: "Плохо", score: 0 }, { text: "Хорошо", score: 2 }] },
      { id: "q2", text: "Вопрос 2", options: [{ text: "Плохо", score: 0, echo: "плохо" }, { text: "Средне", score: 1 }, { text: "Хорошо", score: 2 }] },
    ],
    bands: [
      { key: "низкий", min: 0, max: 0.5, title: "Низкий", text: "текст низкого", offer: "предложение" },
      { key: "высокий", min: 0.5, max: Infinity, title: "Высокий", text: "текст высокого", offer: "предложение 2" },
    ],
  });
}

test("требует questions и bands", () => {
  assert.throws(() => createDiagEngine({ bands: [{ title: "x" }] }));
  assert.throws(() => createDiagEngine({ questions: [{ id: "a", options: [{ score: 1 }] }] }));
});

test("next возвращает первый незаданный вопрос, done — когда пройдено", () => {
  const квиз = fixture();
  let d = квиз.empty();
  assert.equal(квиз.next(d).id, "q1");
  assert.equal(квиз.done(d), false);
  d = квиз.answer(d, "q1", 1);
  assert.equal(квиз.next(d).id, "q2");
  d = квиз.answer(d, "q2", 2);
  assert.equal(квиз.next(d), undefined);
  assert.equal(квиз.done(d), true);
});

test("answer игнорирует несуществующий id/индекс", () => {
  const квиз = fixture();
  let d = квиз.empty();
  const после1 = квиз.answer(d, "нет-такого", 0);
  assert.deepEqual(после1, d);
  const после2 = квиз.answer(d, "q1", 99);
  assert.deepEqual(после2, d);
});

test("position считает номер и общее число вопросов", () => {
  const квиз = fixture();
  assert.deepEqual(квиз.position(квиз.empty(), "q2"), { number: 2, total: 2 });
});

test("score — доля от максимума, 0..1", () => {
  const квиз = fixture();
  let d = квиз.empty();
  d = квиз.answer(d, "q1", 0); // 0 из 2
  d = квиз.answer(d, "q2", 2); // 2 из 2
  assert.equal(квиз.score(d), 0.5);
});

test("band выбирает первый подходящий диапазон по границам", () => {
  const квиз = fixture();
  let низкий = квиз.empty();
  низкий = квиз.answer(низкий, "q1", 0);
  низкий = квиз.answer(низкий, "q2", 0);
  assert.equal(квиз.band(низкий).key, "низкий");

  let высокий = квиз.empty();
  высокий = квиз.answer(высокий, "q1", 1);
  высокий = квиз.answer(высокий, "q2", 2);
  assert.equal(квиз.band(высокий).key, "высокий");
});

test("result собирает текст банда и сводку ответов, ничего не сочиняя", () => {
  const квиз = fixture();
  let d = квиз.empty();
  d = квиз.answer(d, "q1", 0);
  d = квиз.answer(d, "q2", 0);
  const итог = квиз.result(d);
  assert.equal(итог.band, "низкий");
  assert.match(итог.text, /текст низкого/);
  assert.match(итог.text, /предложение/);
  assert.match(итог.summary, /плохо/);
});

test("weak — echo до 3 ответов с наименьшим баллом, по возрастанию балла", () => {
  const квиз = fixture();
  let d = квиз.empty();
  d = квиз.answer(d, "q1", 1); // score 2, echo нет → упадёт текстом варианта
  d = квиз.answer(d, "q2", 0); // score 0, echo "плохо" — самый слабый ответ
  const итог = квиз.result(d);
  assert.deepEqual(итог.weak, ["плохо", "Хорошо"], "слабейший (score 0) должен быть первым");
});

test("weak — не больше 3 пунктов даже при большем числе вопросов", () => {
  const квиз = createDiagEngine({
    questions: [
      { id: "q1", text: "1", options: [{ text: "a", score: 0, echo: "e1" }] },
      { id: "q2", text: "2", options: [{ text: "b", score: 0, echo: "e2" }] },
      { id: "q3", text: "3", options: [{ text: "c", score: 0, echo: "e3" }] },
      { id: "q4", text: "4", options: [{ text: "d", score: 0, echo: "e4" }] },
    ],
    bands: [{ key: "x", title: "X", text: "t" }],
  });
  let d = квиз.empty();
  for (const q of ["q1", "q2", "q3", "q4"]) d = квиз.answer(d, q, 0);
  assert.equal(квиз.result(d).weak.length, 3);
});
