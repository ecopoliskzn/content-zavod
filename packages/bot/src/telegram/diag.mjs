// Квиз-движок TG-бота (Фаза 4, D-011): вопросы/варианты/баллы и итоговые
// диапазоны (bands) приходят из конфига инстанса, ничего не зашито. Состояние
// прохождения хранится не здесь — вызывающий код кладёт его в объект подписчика
// через telegram/store.mjs (поле "diag"), как и остальные поля store.
//
// Порт идеи lib/telegram/diag.ts kormishin-site: там квиз завязан на три
// конкретные оси и данные миссий kormishin — сюда переносится только механика
// (вопрос → вариант → балл → диапазон), содержание задаёт instance config.

/**
 * @typedef {object} DiagOption
 * @property {string} text текст варианта
 * @property {number} score балл варианта
 * @property {string} [echo] короткая форма для итоговой сводки ("производство")
 */
/**
 * @typedef {object} DiagQuestion
 * @property {string} id
 * @property {string} text
 * @property {string} [label] короткое имя темы для сводки (по умолчанию — text)
 * @property {DiagOption[]} options
 */
/**
 * @typedef {object} DiagBand
 * @property {string} key
 * @property {string} title
 * @property {number} [min] нижняя граница доли баллов (включительно), по умолчанию 0
 * @property {number} [max] верхняя граница (исключительно), по умолчанию +Infinity
 * @property {string} text текстband'а человеку
 * @property {string} [offer] предложение обсудить/записаться, без цен (D-014)
 */

/**
 * @param {object} config
 * @param {DiagQuestion[]} config.questions вопросы в порядке показа
 * @param {DiagBand[]} config.bands диапазоны итога, проверяются по порядку списка
 */
export function createDiagEngine(config = {}) {
  const questions = config.questions || [];
  const bands = config.bands || [];
  if (!questions.length) throw new TypeError("createDiagEngine: нужны questions");
  if (!bands.length) throw new TypeError("createDiagEngine: нужны bands");

  const byId = new Map(questions.map((q) => [q.id, q]));

  /** Новое пустое состояние прохождения. */
  function empty() {
    return { at: new Date().toISOString(), answers: {} };
  }

  /** Следующий незаданный вопрос. undefined = пройдено. */
  function next(diag) {
    return questions.find((q) => diag?.answers?.[q.id] === undefined);
  }

  /** Пройдено ли до конца. */
  function done(diag) {
    return !next(diag);
  }

  /** Номер вопроса и сколько всего — для подписи "3 из 7". */
  function position(diag, id) {
    return { number: questions.findIndex((q) => q.id === id) + 1, total: questions.length };
  }

  /** Записывает ответ. Чужой индекс отбрасывается (кнопка могла остаться от старой сборки). */
  function answer(diag, id, index) {
    const q = byId.get(id);
    if (!q || !q.options[index]) return diag;
    return { ...diag, answers: { ...diag.answers, [id]: index } };
  }

  function selected(diag, id) {
    const q = byId.get(id);
    const i = diag?.answers?.[id];
    return q && i !== undefined ? q.options[i] : undefined;
  }

  /** Доля набранных баллов к максимуму, 0..1. */
  function score(diag) {
    let total = 0;
    let max = 0;
    for (const q of questions) {
      max += Math.max(...q.options.map((o) => o.score));
      total += selected(diag, q.id)?.score ?? 0;
    }
    return max ? total / max : 0;
  }

  /** Диапазон итога по доле баллов: первый подходящий по списку конфига. */
  function band(diag) {
    const s = score(diag);
    return bands.find((b) => s >= (b.min ?? 0) && s < (b.max ?? Infinity)) || bands[bands.length - 1];
  }

  /** До 3 echo ответов с наименьшим баллом (воронка v2, "Контракт данных": diag.итог.weak) —
   *  используется и в личном итоге клиенту ("Что у вас сейчас"), и в карточке продавца
   *  ("Болит:"). Сортировка стабильна: при равном балле порядок — как в списке вопросов.
   *  Ничего не сочиняет сверх ответов человека — echo варианта, а не свободный текст. */
  function weak(diag, limit = 3) {
    return questions
      .map((q) => selected(diag, q.id))
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
      .map((o) => o.echo || o.text);
  }

  /** Собирает итог: текст банда + сводка выбранных ответов. Ничего не сочиняет сверх конфига. */
  function result(diag) {
    const s = score(diag);
    const b = band(diag);
    const карточка = questions
      .map((q) => {
        const v = selected(diag, q.id);
        return v ? `${q.label || q.text}: ${v.echo || v.text}` : null;
      })
      .filter(Boolean)
      .join("\n");
    // Пустая строка МЕЖДУ блоками (title/text/offer), не внутри них: раньше тут стояли
    // литеральные "" в массиве для отступа, но .filter(s !== "") их же и вычищал — блоки
    // склеивались одинарным \n без ритма (owner 2026-09-28: «не хватает пустых строк»).
    const text = [b?.title, b?.text, b?.offer].filter((s) => s !== undefined && s !== "").join("\n\n");
    return { score: s, band: b?.key, title: b?.title, text, summary: карточка, weak: weak(diag) };
  }

  return { empty, next, done, position, answer, selected, score, band, weak, result, questions, bands };
}
