# @liga/bot

Общий движок ботов сети (D-011): IG-автоответ по кодовым словам + минимальный
TG-бот, переиспользуемые между инстансами (`leanliga`, `bot-alyona`, …, дальше
kormishin — см. Фазу 6 плана). Порт логики из `kormishin-site` (`lib/ig/*`,
`lib/telegram/*`, `workers/*-relay`), без хардкодов конкретного сайта.

## Статус (Фаза 1 из `.planning/plans/BOT-ALYONA-PLAN.md`)

Перенесено и покрыто тестами:

- **IG-ядро**: подбор сценария по кодовому слову (`src/ig/match.mjs` — точное
  совпадение > самая длинная подстрока > шаблон, с исключениями), загрузка
  сценариев из массива или директории с `*.json` (`src/ig/scenarios.mjs`),
  очередь "досылки" jsonl (`src/ig/queue.mjs`), клиент отправки в директ через
  `ig-relay` (`src/ig/relay.mjs`), разбор вебхука + проверка подписи
  HMAC-SHA256, framework-agnostic (`src/ig/webhook.mjs`).
- **TG-минимум**: jsonl-хранилище подписчиков с queue-safe слиянием записей
  (`src/telegram/store.mjs`), разбор `/start <метка>` deep-link
  (`src/telegram/entry.mjs`), texts-API с подстановкой плейсхолдеров
  (`src/telegram/texts.mjs`), клиент отправки через `tg-relay`
  (`src/telegram/relay.mjs`).
- **`createBotInstance(config)`** (`src/index.mjs`) — собирает инстанс из
  конфига, ничего не хардкодит.

## Конфиг инстанса

```js
import { createBotInstance } from "@liga/bot";

const bot = createBotInstance({
  id: "alyona",
  storageDir: "/opt/leads-alyona",       // 152-ФЗ: свой каталог на VPS в РФ
  scenarios: "/path/to/scenarios",        // директория с *.json ИЛИ массив сценариев
  texts: { welcome: "Привет, {имя}!" },   // словарь текстов TG-бота инстанса
  materials: [{ key: "forbes", intro: "…" }],
  sourceTagPrefix: "alyona",              // метка лида: "alyona:<площадка>"
  recipients: [{ id: "-100123..." }],     // получатели уведомлений (TG chat id)
  igRelay: {
    url: "https://ig-relay-alyona.workers.dev",
    relaySecret: process.env.ALYONA_IG_RELAY_SECRET,
    igToken: process.env.ALYONA_IG_TOKEN,
    appSecret: process.env.ALYONA_IG_MSG_APP_SECRET,   // HMAC вебхука
    verifyToken: process.env.ALYONA_IG_WEBHOOK_VERIFY_TOKEN,
  },
  tgRelay: {
    url: "https://tg-relay-alyona.workers.dev",
    relaySecret: process.env.ALYONA_TG_RELAY_SECRET,
    botUsername: "alyona_bot",
  },
});
```

Пакет **не читает `process.env` сам** — имена переменных и env-префикс
(например `ALYONA_`) выбирает приложение-потребитель (`apps/bot-alyona`,
Фаза 2) и передаёт уже разрешённые значения в конфиг. Так один процесс может
держать несколько инстансов одновременно, и тесты не трогают окружение.

Основные точки конфига:

| Поле | Смысл |
|---|---|
| `id` | идентификатор инстанса |
| `storageDir` | каталог хранилища (ПДн, 152-ФЗ — на VPS в РФ) |
| `scenarios` | сценарии кодовых слов IG: массив или путь к директории |
| `texts` | словарь текстов TG (плоский или вложенный через `.`) |
| `materials` | материалы, отдаваемые по кодовому слову/deep-link (`{key, intro}`) |
| `sourceTagPrefix` | префикс метки источника лида |
| `recipients` | получатели уведомлений |
| `igRelay` / `tgRelay` | URL и секреты релеев (уже разрешённые значения, не имена env) |

## Заявки → amoCRM (Фаза 3)

`src/crm/amo.mjs` — `createAmoClient({ baseUrl, getToken, pipelineId, statusId,
tagPrefix, fields })`: framework-agnostic порт `lib/amo.ts` kormishin
(контакт+сделка в «Входящие лиды», метка источника и кастомные поля через
`fields`). `getToken` — значение или функция (задел под oauth-рефреш), пакет
токены не хранит и не обновляет сам.

`src/leads.mjs` — `createLeadStore({ storageDir, crm, sourceTagPrefix })`:
store-and-forward, как `lib/telegram/lead.ts` kormishin — `saveLead` дописывает
лид в `<storageDir>/leads.jsonl` раньше любой сетевой попытки, `submitLead`
затем пробует `crm.pushLead(lead, sourceLabel)` и дописывает результат/ошибку в
`<storageDir>/leads-crm.jsonl`; сбой CRM не бросает исключение и не теряет лид.
`retryFailed()` повторяет лиды без успешной последней попытки.

## Что осталось на потом (Фазы 4–6 плана)

- Приложение экземпляра `apps/bot-alyona` реализует конкретный сценарий сбора
  заявки поверх `leads.mjs`/`amo.mjs` (Фаза 3 уже сделана там же).
- Диагностика/дожим/утренний отчёт (Фаза 4;
  соответствуют `lib/telegram/{diag,followup}.ts` и `scripts/bot-report.mjs`
  kormishin — **не портировались**), площадки TG-канал/Threads/VK/YouTube
  (Фаза 5).
- Перевод kormishin на этот пакет — отдельная задача в сессии kormishin-site,
  после согласования владельца (Фаза 6).
- `lib/telegram/entry.ts` в kormishin несёт много бизнес-веток (миссии, лист
  ожидания, голосование за события, алиасы слагов) — они завязаны на
  `data/missions.json`/`data/radar.json` конкретного сайта и в пакет не
  перенесены. `src/telegram/entry.mjs` здесь — generic-ядро (три формы deep-link,
  отсечение IGSID-хвоста, материал по ключу, канал по префиксу); бизнес-ветки
  каждый инстанс строит поверх него сам через `materialByEntry`/`платформы`.

## Тесты

```bash
pnpm --filter @liga/bot test
```

Используется `node --test`, как и в kormishin-site. Фикстуры (`test/fixtures/*`)
— нейтральные, без боевого контента kormishin или Алёны.
