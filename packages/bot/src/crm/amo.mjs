// Клиент amoCRM: framework-agnostic порт lib/amo.ts из kormishin-site, урезанный
// до общего ядра «лид → сделка в «Входящих лидах»». Ничего из process.env не читает:
// baseUrl, токен (или геттер токена — для будущего oauth-рефреша) и id воронки/полей
// приходят конфигом от приложения-потребителя (D-011: пакет инстанс-агностичен).
//
// Доставка best-effort: сбой amoCRM не должен ронять лид — вызывающая сторона (leads.mjs)
// уже записала его в jsonl-буфер до вызова этого клиента.

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function cfv(field_id, value) {
  return field_id != null && value !== undefined && value !== null && value !== ""
    ? { field_id, values: [{ value }] }
    : null;
}

/**
 * @param {object} конфиг
 * @param {string} конфиг.baseUrl адрес аккаунта amoCRM, например https://example.amocrm.ru
 * @param {string} [конфиг.subdomain] поддомен аккаунта (справочно, в запросах не используется
 *   напрямую — оставлен для инстансов, которым удобнее собирать baseUrl из него)
 * @param {string|(() => (string|Promise<string>))} конфиг.getToken access-токен или геттер токена
 *   (функция — задел под oauth-рефреш: пакет не хранит и не обновляет токены сам)
 * @param {number} [конфиг.pipelineId] id воронки для новых сделок
 * @param {number} [конфиг.statusId] id статуса (этапа) для новых сделок
 * @param {string} [конфиг.tagPrefix] префикс метки лида/source_uid, например "alyona"
 * @param {string} [конфиг.formName] «Форма»/источник для metadata и имени сделки
 * @param {object} [конфиг.fields] id кастомных полей amoCRM
 * @param {number} [конфиг.fields.source] поле сделки: метка источника (sourceLabel)
 * @param {number} [конфиг.fields.task] поле сделки: текст заявки
 * @param {number} [конфиг.fields.contactPhone] поле контакта: телефон
 * @param {number} [конфиг.fields.contactUsername] поле контакта: телеграм/инстаграм-ник
 * @param {Record<string, number>} [конфиг.fields.custom] произвольные доп. поля сделки:
 *   { ключЛида: field_id } — значение берётся из lead[ключЛида]
 */
export function createAmoClient(config = {}) {
  const {
    baseUrl,
    subdomain,
    getToken,
    pipelineId,
    statusId,
    tagPrefix,
    formName = "Бот",
    fields = {},
  } = config;

  if (!baseUrl) throw new TypeError("createAmoClient: нужен baseUrl");
  if (!getToken) throw new TypeError("createAmoClient: нужен getToken (значение или функция)");

  async function resolveToken() {
    return typeof getToken === "function" ? await getToken() : getToken;
  }

  /**
   * Заводит лид в «Входящие лиды» (unsorted/forms) — контакт + сделка одним запросом,
   * как в kormishin-site. sourceLabel — человекочитаемый ярлык источника (см. lead-source.ts
   * kormishin), lead — произвольный объект (name, phone/contact, task, id, ...).
   */
  async function pushLead(lead = {}, sourceLabel) {
    const token = await resolveToken();
    if (!token) return { ok: false, error: "amo: нет токена" };

    const name = str(lead.name) || "Без имени";
    const phone = str(lead.phone) || str(lead.contact);
    const username = str(lead.username) || str(lead.telegramUsername);
    const now = Math.floor(Date.now() / 1000);
    const label = str(sourceLabel) || str(lead.source) || "";
    const leadName = [formName, label].filter(Boolean).join(" · ");

    const leadCfv = [
      cfv(fields.source, label || undefined),
      cfv(fields.task, str(lead.task)),
      ...Object.entries(fields.custom || {}).map(([key, fieldId]) => cfv(fieldId, str(lead[key]))),
    ].filter((x) => x !== null);

    const contactCfv = [
      phone ? { field_id: fields.contactPhone, ...{ values: [{ value: phone }] } } : null,
      username && fields.contactUsername ? { field_id: fields.contactUsername, values: [{ value: username }] } : null,
    ].filter((x) => x !== null && x.field_id != null);

    // Заявка может переопределить воронку/этап (lead.pipelineId/lead.statusId) и нести метки
    // (lead.tags: строки), например лист ожидания в воронке «Поездки».
    const leadPipelineId = Number(lead.pipelineId) || pipelineId;
    const leadStatusId = Number(lead.statusId) || statusId;
    const tags = (Array.isArray(lead.tags) ? lead.tags : []).map(str).filter(Boolean).map((name) => ({ name }));

    const body = [
      {
        source_name: formName,
        source_uid: `${tagPrefix || "bot"}-${str(lead.id) || now}`,
        pipeline_id: leadPipelineId,
        created_at: now,
        metadata: {
          form_id: tagPrefix || "bot",
          form_name: leadName,
          form_sent_at: now,
        },
        _embedded: {
          contacts: [{ name, custom_fields_values: contactCfv.length ? contactCfv : undefined }],
          leads: [
            {
              name: leadName,
              pipeline_id: leadPipelineId,
              status_id: leadStatusId,
              custom_fields_values: leadCfv.length ? leadCfv : undefined,
              _embedded: tags.length ? { tags } : undefined,
            },
          ],
        },
      },
    ];

    try {
      const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/v4/leads/unsorted/forms`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return { ok: false, error: `amo ${r.status}: ${t.slice(0, 200)}` };
      }
      const j = await r.json();
      const id = j?._embedded?.unsorted?.[0]?._embedded?.leads?.[0]?.id;
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { pushLead, subdomain, baseUrl };
}
