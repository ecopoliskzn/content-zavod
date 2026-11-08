# S0: границы следующей доработки по поручению «доводи»

Основание проверено чтением исходных сообщений Запускатора: после списка автоматической передачи редакторам, всех площадок/видео и GitHub/backup пользователь ответил «доводи», userMessage `01a1bbb6-d289-7282-aea3-90be243c7509`. Тема309 и карточка312 повторно не создаются; customer leads остаются закрыты.

## Владение файлами

- S0: `ops/intake-dispatch*.mjs`, соответствующие тесты/документация, локальный обычный процесс доставки событий, backup-диагностика, `ops/admin-status.json`, safe evidence и манифест GitHub. Общие server/pump/deploy — S0 после коммитов владельцев и проверок.
- S3: `src/bot/media-intake*.mjs` core/runtime/target registry и их собственные тесты. S0 не меняет их параллельно. Исключение — уже закреплённые S0 CLI/pump/sync, если S3 не объявил иной захват.
- S2: `src/bot/media-intake-delivery.mjs`, расширение реальных текстовых/фото/видеопутей и его тесты. S0 этот файл не правит.

## Запрашиваемый контракт событийного диспетчера

Обычный код на компьютере оператора читает только метаданные готовых jobs: `id`, `materialId`, `revision`, `inputHash`, `status`, `ownerRole` (S1/S2). Нужен явный ownerRole по назначению/типу работы; диспетчер не читает исходники, полный brief, приватные ответы или оригиналы для выбора роли.

Конверт в существующую сессию: `dispatchId`, `jobId`, `materialId`, `revision`, `inputHash`, роль и разрешённый путь команды забора. Без авторов, текста переписки, токенов, подписанных адресов и файлов. Модель и thinking не переопределяются.

До внешнего действия сохраняется устойчивый dispatchId/requestId. Код различает planned/sending/queued/accepted/unknown/cancelled. Успех `codex queue` сам по себе не означает принятие редактором: оно подтверждается штатным claim с тем же requestId и актуальными revision/inputHash. После обрыва — сверка, не слепая повторная отправка. Изменённое/отменённое задание не передаётся повторно под старой версией.

Для этого S3 нужен безопасный metadata endpoint либо расширение `intake-jobs` без содержимого; claim уже поддерживает requestId. S0 добавит consumer-CLI поддержку переданного requestId без печати токена. Требуется обратная метадата claim.requestId/owner/версия для конкретного dispatch, без возврата самого токена. Новый серверный контракт должен сохранять staff-only границу и не давать права публикации.

Уточнение приёмной квитанции: S3facts меняет inputHash без новой revision. Поэтому сервер сохраняет неизменные `requestId`, `owner`, `initialInputHash`, `at` в claim и безопасной истории принятия. Метаданные этой квитанции должны оставаться доступны после facts, completed и release; текущий inputHash не заменяет initialInputHash. Старый dispatch подтверждается только точным совпадением его исходного хеша, requestId, роли, materialId и revision. Завершённая работа между двумя опросами не порождает повторную отправку. S0 не редактирует core/runtime параллельно S3.

Точный ожидаемый metadata shape в реализации S0: `intake-jobs` возвращает `id/materialId/revision/inputHash/status/recipient/protocolVersion/manifestRevision/acceptedClaims[]`; элемент acceptedClaims — `{requestId,owner,initialInputHash,at}`. Обычный диспетчер сверяет исходный хеш dispatch с initialInputHash, не с изменившимся job.inputHash. Для безопасного consumer-view S3 также нужен явный job.budget `{maxJobInput,maxJobOutput,maxCalls}` из действующих лимитов. При отсутствии бюджетов view честно возвращает null, consumer не считает лимиты установленными.

S0 CLI реализованы `claim --id=<16hex> --owner=S1|S2 --request-id=<32hex>`, `context --claim=<closedReceipt.json>`, `view --claim=<closedReceipt.json>`, `source --claim=<closedReceipt.json> --id=<sourceId>`, `result --claim=<closedReceipt.json> --result=<result.json>`. Закрытый receipt нельзя печатать. Source selector возвращает ограниченный целый client-page/client-document с SHA, запрещает author_statement/контакты/секретные URL. View содержит sourceRef с проверкой точного совпадения locator и substring факта; это связь с источником, а не автоматический редакторский вердикт. Приватная переписка и атрибуция не выводятся. Result допускает отсутствие entry.facts только при явном variant.factRefs, точно равном массиву выбранных claims; code подставляет закрытую атрибуцию после свежего context и проверки неизменности inputHash. Иной список фактов и старый хеш отклоняются.

S0 общая очередь: отдельный `intake-youtube-first.mjs` связывает управляемые video/short/reel по точному material/revision/job/targetEntryName и queueResults.targetKey, ждёт published + актуальный contentHash + result.id/link. Старый pipeline сохраняет проверку по имени. Фото/text не ждут YouTube. Целевые тесты прошли; S2 после сверки может снять свой временный failclosed guard разных имён в delivery. Общий npm test после первого набора правок всё ещё отказал на S3 карточке: ожидается «На согласовании», фактически «В подготовке» (media-intake.test.mjs:176); не объявлен зелёным и не выложен.

Проверка A идёт официальным локальным Codex transport, с обычным review и раскрытием прежних отказов. При отказе фиксируется фактическая причина, B не переименовывается в A. Пустой кодовый опрос не вызывает модель; новые чаты, платный API, automation и контент-runner не создаются. Прежний сторож не снимается без замены.

## Backup и GitHub

Диагностика использует существующий российский backup, штатные ключевые helper и безопасные агрегаты. Никаких новых покупок, Terms, ротации ключей/прав или публичности. P14 только после независимого зашифрованного PUT/download/SHA/изолированного restore с покрытием.

GitHub: сначала точный законченный манифест коммитов, diff и проверка отсутствия секретов/персональных данных/медиа/архивов, затем обычный review fast-forward push конкретного payload в согласованный main. Старые967/60/661 уже отправлены; повторные вопросы на них не нужны. Состояния local/remote/server проверяются отдельно. Общая выкладка только S0 после S3/S2 коммитов; никаких конкурентных deploy.
