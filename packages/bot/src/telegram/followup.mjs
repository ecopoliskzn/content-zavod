// Дожим/drip-цепочка после материала (Фаза 4, D-011): шаги (через сколько часов,
// что сказать) приходят из instance config, ничего не зашито. Хранение — тот же
// store, что у остальных полей подписчика (telegram/store.mjs, jsonl-бэкенд),
// отправка — через переданную функцию send (обычно client.sendMessage релея
// инстанса), сам движок сети не знает.
//
// Порт механики lib/telegram/followup.ts kormishin-site (шаги, тихие часы,
// снятие цепочки после ответа) без конкретных сценариев kormishin (туры,
// материалы) — их задаёт config.scenarios каждого инстанса.

/**
 * @typedef {object} FollowupStep
 * @property {number} afterHours сколько часов после предыдущего шага (или после schedule() для шага 0)
 * @property {(subject: string) => string} text
 * @property {unknown} [buttons] произвольные кнопки шага: значение или (subject) => значение,
 *   прокидывается в send как есть — формат кнопок задаёт relay-клиент инстанса
 */

/**
 * @param {object} deps
 * @param {{
 *   readSubscribers: () => Promise<object[]>,
 *   findSubscriber: (id: string) => Promise<object|undefined>,
 *   upsertSubscriber: (id: string, patch: object) => Promise<object>,
 * }} deps.store telegram/store.mjs инстанса
 * @param {Record<string, FollowupStep[]>} deps.scenarios сценарии по имени
 * @param {(id: string, text: string, extra: { buttons?: unknown }) => Promise<{ ok: boolean, status?: number }>} deps.send
 * @param {(sub: object) => boolean} [deps.canSend] доп. условие отправки (например, согласие на рекламу):
 *   если вернёт false — шаг на тике пропускается (не отправляется, цепочка не меняется)
 * @param {(now: Date) => boolean} [deps.quietHours] переопределение тихих часов (по умолчанию 22:00–09:00 МСК)
 */
export function createFollowupEngine({ store, scenarios = {}, send, quietHours, canSend } = {}) {
  if (!store) throw new TypeError("createFollowupEngine: нужен store");
  if (typeof send !== "function") throw new TypeError("createFollowupEngine: нужен send(id, text, extra)");

  function defaultQuietHours(now = new Date()) {
    const msk = (now.getUTCHours() + 3) % 24;
    return msk >= 22 || msk < 9;
  }
  const isQuietHours = typeof quietHours === "function" ? quietHours : defaultQuietHours;

  /** Ставит цепочку сценария на подписчика. Первый шаг — через steps[0].afterHours от сейчас. */
  async function schedule(id, subject = "", scenario) {
    const steps = scenarios[scenario];
    if (!steps || !steps.length) throw new TypeError(`createFollowupEngine.schedule: нет сценария "${scenario}"`);
    const nextAt = new Date(Date.now() + steps[0].afterHours * 3600_000).toISOString();
    return store.upsertSubscriber(id, { followup: { scenario, step: 0, nextAt, subject } });
  }

  /** Снимает цепочку: человек ответил, оставил заявку, отписался — решает вызывающий код. */
  async function cancel(id) {
    return store.upsertSubscriber(id, { followup: null });
  }

  function eligible(sub, now) {
    const steps = scenarios[sub?.followup?.scenario || ""];
    if (!sub?.followup || !steps) return false;
    if (sub.status && sub.status !== "active") return false;
    if (typeof canSend === "function" && !canSend(sub)) return false;
    if (sub.followup.step >= steps.length) return false;
    if (new Date(sub.followup.nextAt) > now) return false;
    return true;
  }

  /** Кому назрело написать прямо сейчас, из уже прочитанного списка (для тестов/отчётов). */
  function due(list, now = new Date()) {
    return list.filter((s) => eligible(s, now));
  }

  /**
   * Отправляет то, что назрело. Вызывается кроном/интервалом. Возвращает счётчики
   * для журнала: sent/blocked, skipped=-1 значит "тихие часы, ничего не смотрели".
   */
  async function tick(now = new Date()) {
    if (isQuietHours(now)) return { sent: 0, blocked: 0, skipped: -1 };

    const all = await store.readSubscribers();
    const list = due(all, now);
    let sent = 0;
    let blocked = 0;

    for (const s of list) {
      const steps = scenarios[s.followup.scenario];
      const step = steps[s.followup.step];
      const subject = s.followup.subject || "";
      const text = typeof step.text === "function" ? step.text(subject) : step.text;
      const buttons = typeof step.buttons === "function" ? step.buttons(subject) : step.buttons;

      const res = await send(s.id, text, { buttons }).catch(() => ({ ok: false, status: 0 }));

      if (res.ok) {
        sent++;
        // Проход по списку длится время: если человек за это время сам ответил/снял
        // цепочку, восстанавливать её из устаревшего снимка нельзя (см. followup.ts).
        const current = await store.findSubscriber(s.id);
        const same =
          current?.followup && current.followup.scenario === s.followup.scenario && current.followup.step === s.followup.step;
        if (!same) continue;

        const nextStep = s.followup.step + 1;
        await store.upsertSubscriber(s.id, {
          followup:
            nextStep >= steps.length
              ? null
              : {
                  ...s.followup,
                  step: nextStep,
                  nextAt: new Date(now.getTime() + steps[nextStep].afterHours * 3600_000).toISOString(),
                },
        });
      } else if (res.status === 403) {
        blocked++;
        await store.upsertSubscriber(s.id, { status: "blocked", followup: null });
      }
    }

    return { sent, blocked, skipped: all.length - list.length };
  }

  return { schedule, cancel, due, eligible, tick, quietHours: isQuietHours };
}
