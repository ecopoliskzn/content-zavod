// Реестр переменных окружения: имя, где живёт, секрет ли это и зачем нужна.
//
// Один список на четыре дела: проверка окружения (doctor), сверка копий ключей между
// компьютером и сервером, образец .env.example и карточки ключей в витрине Obsidian.
// ЗНАЧЕНИЙ здесь нет и быть не может: только имена.
//
// where:  server   — сервер завода в России;
//         operator — компьютер оператора (Codex, загрузка файлов, дубль расписания);
//         relay    — секреты релея за границей (на сервере и компьютере их нет).
// need:   core     — без переменной завод не запускается;
//         channel:<имя> — нужна, когда подключена площадка;
//         optional — улучшает работу, но можно без неё.

export const REGISTRY = [
  // ── Общее ────────────────────────────────────────────────────────────────
  { name: "DATA_DIR", where: ["server"], secret: false, need: "core", what: "каталог данных отдельно от кода: /opt/ecopolis-data. Переживает выкладку" },
  { name: "PUBLIC_BASE_URL", where: ["server", "operator"], secret: false, need: "core", what: "адрес завода с https: счётчик ссылок /go, формы /z, документы /doc" },
  { name: "PORT", where: ["server"], secret: false, need: "optional", what: "порт сервера завода, по умолчанию 3100 (слушает только 127.0.0.1)" },
  { name: "ADMIN_API_TOKEN", where: ["server", "operator"], secret: true, need: "core", what: "ключ оператора к очереди на сервере (/admin/queue)" },
  { name: "QUEUE_API_BASE", where: ["operator"], secret: false, need: "core", what: "адрес сервера для команд очереди с компьютера; обычно равен PUBLIC_BASE_URL" },
  { name: "OPERATOR_NAME", where: ["operator"], secret: false, need: "optional", what: "кто правит очередь: пишется в историю записи" },
  { name: "MIRROR_DIR", where: ["operator"], secret: false, need: "optional", what: "каталог дубля расписания, по умолчанию mirror/ в корне проекта" },

  // ── Telegram: бот, рабочая группа, канал ─────────────────────────────────
  { name: "TG_BOT_TOKEN", where: ["relay"], secret: true, need: "core", what: "токен бота от BotFather. Лежит только в секретах релея" },
  { name: "TG_RELAY_URL", where: ["server", "operator"], secret: false, need: "core", what: "адрес релея: через него идут вызовы Bot API и приходят обновления" },
  { name: "TG_RELAY_SECRET", where: ["server", "operator", "relay"], secret: true, need: "core", what: "общий секрет сервера и релея" },
  { name: "TG_WEBHOOK_SECRET", where: ["server", "relay"], secret: true, need: "core", what: "секрет, с которым релей передаёт обновления Telegram серверу" },
  { name: "TG_BOT_USERNAME", where: ["server", "operator"], secret: false, need: "core", what: "имя бота без @: из него строятся ссылки с метками" },
  { name: "TG_GROUP_ID", where: ["server", "operator"], secret: false, need: "core", what: "номер рабочей группы (-100…): согласование, заявки, отчёты, тревоги" },
  { name: "TG_TOPIC_APPROVAL", where: ["server"], secret: false, need: "optional", what: "номер темы «Согласование» в группе с темами" },
  { name: "TG_TOPIC_LEADS", where: ["server"], secret: false, need: "optional", what: "номер темы «Заявки»" },
  { name: "TG_TOPIC_REPORTS", where: ["server"], secret: false, need: "optional", what: "номер темы «Отчёты»" },
  { name: "TG_TOPIC_ALERTS", where: ["server", "operator"], secret: false, need: "optional", what: "номер темы «Тревоги»" },
  { name: "TG_TOPIC_NEWS", where: ["server"], secret: false, need: "optional", what: "номер темы «Новости»" },
  { name: "TG_TOPIC_PACKAGES", where: ["server"], secret: false, need: "optional", what: "номер темы «Выложить руками» (Дзен)" },
  { name: "TG_TOPIC_COMMENTS", where: ["server"], secret: false, need: "optional", what: "номер темы «Комментарии»: сводка новых комментариев и ответы на согласование" },
  { name: "APPROVER_IDS", where: ["server"], secret: false, need: "core", what: "числовые id Telegram тех, чьё «Одобрить» считается согласием клиента" },
  { name: "STAFF_IDS", where: ["server"], secret: false, need: "optional", what: "id сотрудников, которым доступны кнопки заявок" },
  { name: "TG_CHANNEL", where: ["server", "operator"], secret: false, need: "channel:telegram", what: "канал клиента: @имя или -100…; бот в нём администратор" },

  // ── Threads ──────────────────────────────────────────────────────────────
  { name: "THREADS_TOKEN", where: ["server", "operator"], secret: true, need: "channel:threads", expires: "THREADS_TOKEN_EXPIRES", what: "маркер аккаунта Threads на 60 дней, продлевается сам" },
  { name: "THREADS_USER_ID", where: ["server", "operator"], secret: false, need: "channel:threads", what: "номер аккаунта Threads" },
  { name: "THREADS_USERNAME", where: ["server"], secret: false, need: "optional", what: "имя аккаунта Threads без @: чтобы сборщик комментариев не считал собственные ответы чужими" },
  { name: "THREADS_TOKEN_EXPIRES", where: ["server", "operator"], secret: false, need: "channel:threads", what: "дата, когда маркер истечёт (ГГГГ-ММ-ДД): её ведёт продление" },

  // ── Instagram ────────────────────────────────────────────────────────────
  { name: "IG_TOKEN", where: ["server", "operator"], secret: true, need: "channel:instagram", expires: "IG_TOKEN_EXPIRES", what: "маркер аккаунта Instagram на 60 дней, продлевается сам" },
  { name: "IG_USER_ID", where: ["server", "operator"], secret: false, need: "channel:instagram", what: "номер профессионального аккаунта Instagram" },
  { name: "IG_USERNAME", where: ["server"], secret: false, need: "optional", what: "имя аккаунта без @: чтобы бот не отвечал на собственные комментарии" },
  { name: "IG_TOKEN_EXPIRES", where: ["server", "operator"], secret: false, need: "channel:instagram", what: "дата, когда маркер истечёт" },
  { name: "IG_RELAY_URL", where: ["server"], secret: false, need: "channel:instagram", what: "адрес релея для вызовов к graph.instagram.com (с сервера в России напрямую не ходит)" },
  { name: "IG_RELAY_SECRET", where: ["server", "relay"], secret: true, need: "channel:instagram", what: "общий секрет сервера и релея Instagram" },
  { name: "IG_FORWARD_SECRET", where: ["server"], secret: true, need: "channel:instagram", what: "первый месяц: секрет пары, которым приложение исполнителя подписывает пересылаемые события" },
  { name: "IG_APP_SECRET", where: ["server"], secret: true, need: "optional", what: "после переезда на своё приложение Meta: его секрет для проверки подписи событий" },
  { name: "IG_WEBHOOK_VERIFY_TOKEN", where: ["server"], secret: true, need: "optional", what: "после переезда: слово для подтверждения вебхука своим приложением" },
  { name: "IG_POLL", where: ["server"], secret: false, need: "optional", what: "1 — читать комментарии опросом раз в пять минут (если события о комментариях не приходят)" },

  // ── ВКонтакте ────────────────────────────────────────────────────────────
  { name: "VK_GROUP_ID", where: ["server", "operator"], secret: false, need: "channel:vk", what: "номер сообщества без минуса" },
  { name: "VK_GROUP_TOKEN", where: ["server", "operator"], secret: true, need: "channel:vk", what: "ключ сообщества: текстовые записи со ссылкой на стену" },
  { name: "VK_APP_ID", where: ["server"], secret: false, need: "optional", what: "номер приложения компании в кабинете VK ID: нужен для ключа администратора" },
  { name: "VK_USER_TOKEN", where: ["server"], secret: true, need: "optional", expires: "VK_USER_TOKEN_EXPIRES", what: "ключ администратора сообщества: загрузка фото и видео. Живёт час, обновляется сам; хранится только на сервере" },
  { name: "VK_USER_REFRESH_TOKEN", where: ["server"], secret: true, need: "optional", what: "ключ обновления VK ID: меняется при каждом обновлении, поэтому живёт в одном месте" },
  { name: "VK_DEVICE_ID", where: ["server"], secret: false, need: "optional", what: "номер устройства из входа VK ID: нужен для обновления ключа" },
  { name: "VK_USER_TOKEN_EXPIRES", where: ["server"], secret: false, need: "optional", what: "когда истекает ключ администратора: ведёт обновление" },
  { name: "VK_SERVICE_TOKEN", where: ["server"], secret: true, need: "optional", what: "сервисный ключ приложения: просмотры своих записей и чтение чужих стен" },

  // ── YouTube ──────────────────────────────────────────────────────────────
  { name: "YOUTUBE_CLIENT_ID", where: ["server", "operator"], secret: false, need: "channel:youtube", what: "идентификатор клиента OAuth из проекта Google клиента" },
  { name: "YOUTUBE_CLIENT_SECRET", where: ["server", "operator"], secret: true, need: "channel:youtube", what: "секрет клиента OAuth" },
  { name: "YOUTUBE_REFRESH_TOKEN", where: ["server", "operator"], secret: true, need: "channel:youtube", what: "ключ обновления: появляется после входа владельца канала (npm run yt -- --login)" },
  { name: "YOUTUBE_API_KEY", where: ["server", "operator"], secret: true, need: "optional", what: "открытый ключ API: чтение цифр и каналов конкурентов без входа" },
  { name: "YOUTUBE_CHANNEL_ID", where: ["server", "operator"], secret: false, need: "channel:youtube", what: "номер канала клиента: защита от входа не тем аккаунтом Google" },
  { name: "YOUTUBE_TOKEN_ISSUED", where: ["server", "operator"], secret: false, need: "optional", what: "дата входа: в режиме «Тестирование» ключ живёт 7 дней" },

  // ── Rutube ───────────────────────────────────────────────────────────────
  { name: "RUTUBE_TOKEN", where: ["server", "operator"], secret: true, need: "optional", what: "ключ Rutube: без него ролики идут пакетом на ручную загрузку. Выдаётся по логину и паролю, которые вводит владелец аккаунта" },
  { name: "RUTUBE_CATEGORY", where: ["server"], secret: false, need: "optional", what: "номер категории ролика: 67 «Бизнес и предпринимательство» (по умолчанию), 17 «Обучение», 13 «Разное»" },

  // ── Хранилище файлов ─────────────────────────────────────────────────────
  { name: "S3_ENDPOINT", where: ["operator"], secret: false, need: "channel:instagram", what: "адрес объектного хранилища: https://s3.twcstorage.ru или https://storage.yandexcloud.net" },
  { name: "S3_BUCKET", where: ["operator"], secret: false, need: "channel:instagram", what: "имя бакета с публичным чтением" },
  { name: "S3_REGION", where: ["operator"], secret: false, need: "optional", what: "регион: ru-1 у Timeweb, ru-central1 у Яндекса" },
  { name: "S3_ACCESS_KEY", where: ["operator"], secret: true, need: "channel:instagram", what: "ключ доступа к хранилищу" },
  { name: "S3_SECRET_KEY", where: ["operator"], secret: true, need: "channel:instagram", what: "секретный ключ хранилища" },
  { name: "S3_PUBLIC_BASE", where: ["operator"], secret: false, need: "optional", what: "публичный адрес бакета, если он отличается от адреса хранилища" },

  // ── Заявки и документы ───────────────────────────────────────────────────
  { name: "CONSENT_URL", where: ["server"], secret: false, need: "optional", what: "адрес полного текста согласия на обработку; по умолчанию /doc/soglasie на заводе" },
  { name: "POLICY_URL", where: ["server"], secret: false, need: "optional", what: "адрес политики обработки персональных данных" },
  { name: "ADS_CONSENT_URL", where: ["server"], secret: false, need: "optional", what: "адрес согласия на рассылку" },
  { name: "LEAD_SLA_MIN", where: ["server"], secret: false, need: "optional", what: "срок ответа на заявку в рабочих минутах, по умолчанию 60" },
];

export const byName = (name) => REGISTRY.find((r) => r.name === name);
export const secrets = () => REGISTRY.filter((r) => r.secret).map((r) => r.name);

/** Какие переменные обязательны на этой машине при этих подключённых площадках. */
export function required(where, channels = []) {
  return REGISTRY.filter((r) => r.where.includes(where) && (r.need === "core" || channels.some((c) => r.need === `channel:${c}`))).map((r) => r.name);
}
