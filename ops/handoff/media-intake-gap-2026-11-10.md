# S0: фактический остаток Telegram intake, 10.11.2026

Приоритетный ремонт Threads завершён: код d93b86b, отчёт88b7a49. Сервер `d93b86b 20261110-091744`, живые2 комментария, штатная сводка318, фактический cron09:20UTC без дубля. Не откатывать сбор и его управляемую строку. GitHub отдельно проверен: main6611e1e, поздний пакет ещё не отправлен.

## Код / установлено / включено / проверено

- Core S3 d8f5890 и видео S2 37ba2dc сохранены и вошли в чистую установку d93b86b. Consumer docs f168da5/c68c2a2 сохранены. YouTube preflight ещё не подключён к runner.
- Собственные незакоммиченные intake CLI/flow-tests/host/probe, approved-media/library, trusted manual route и runner сохранены в рабочем дереве. Они не выдаются за установленные. Исправленный test API уже поддерживает intake-jobs; прежний CLI-flow targeted прошёл.
- Production host не включён: последний metadata-only статус08.11 sendEnabled=false, outbox пуст. Задача EcopolisIntakeEventDispatcher не подтверждена. Старый heartbeat automation-2 не приостановлен.
- Реальные технические Codex-пробы08.11: S1 initial claim, answer resume/context ACK и scoped rework приняты. S2 initial claim и answer resume/context ACK приняты. Всё изолировано в data/, без клиентских публикаций, реального ролика и редакторского passed.
- Прежний IG-чат не возобновился: ReviewWatch сохраняет attempted, consumer ACK отсутствует. Событие повторно не отправлялось. Bundled CLI не имел полного пакета. Изолированно установлен официальный @openai/codex0.166.0-alpha.6 с native package manifest; версия совпадает с Desktop. Start-if-not-running запустил официальный managed daemon без remote control/смены модели. JSONL поверх proxy не соответствует WebSocket framing управляющего сокета и не подтвердил handshake; требуется штатная WebSocket-связь и проверка исходного UUID/модели до resume. Auth-файлы не открывались.
- Перед включением A на сервере10.11: legacy jobs0, v2 jobs0, активных материалов0. Миграция/отъём claim не нужны.
- Актуальные media-S3 f0c8cff и backup-S3 3c97447 подтверждены другими собственными актами. Старую SignatureDoesNotMatch не называть текущим блокером без новой проверки.

## Закончить

1. Проверенный headless resume незагруженных существующих чатов и старого pending без повторной отправки; один обычный host без idle LLM, затем доказанная замена старого heartbeat. Daily GitHub10МСК не менять.
2. Подключить deterministic approved-only YouTube preflight, новый mediaId через проверенный штатный путь без ручного adoptPublic, trusted manual route; ответы/целевые правки не теряют другие targets. Полный контроль, точечные коммиты, одна согласованная установка и свежий P0 акт по реальным квитанциям.
3. Сверить и отправить точный безопасный пакет main через обычный review, проверить remote hash. Client lead intake закрыт; контент без Одобрить не выпускается.

Дополнительно поручен S6 дефект ручного ответа: заголовок без доставленного тела не считается handed; исправление в S0 по TDD, без автоматизации новых черновиков/самих ответов на площадке. Новые ресурсы, покупки, Terms и ротации не выполняются.

## Проверка control socket 10.11

S3 передала c2ccabf: штатный WebSocket helper, 7 изолированных тестов. S0 подключила его к собственному control; профиль transport/control 9/9. Старый JSONL поверх proxy заменён на WebSocket. Ответы истории и auth не запрашиваются; thread/read includeTurns=false, thread/resume excludeTurns=true, без model/config/prompt/turn/start. Проверяются точный UUID, сохранение модели/effort и cleanupComplete.

После подтверждённого connection refused10061 выполнен только start-if-not-running официального ранее установленного daemon0.166.0-alpha.6. Получен status=started, backend=pid, PID7028. Затем реальный handshake и чтение существующего IG UUID прошли: model gpt-6.1-sol, reasoningEffort medium, status notLoaded. Реальный resume отклонён -32600 с фиксированной причиной `already has an active writer`. Генерация не запрашивалась, событие ReviewWatch не отправлялось повторно, writer lock не менялся и чужие процессы не завершались. Чтение notLoaded в отдельном daemon не означает отсутствие владельца в Desktop. Это текущая граница внедрения A: новый host/Task не включать, старый heartbeat не снимать до безопасного штатного присоединения к владельцу и consumer ACK.

Дополнительный TDD закрыл stale queued/unknown при общей новой редакции: runtime возвращает current, отправка требует явного true, отмена старого intent требует false и полного fenced acceptedClaims. Существующее принятие имеет приоритет; отсутствие metadata/истории удерживает повтор. Профиль dispatcher/host/CLI-flow 11/11. Исторический отказ изолированной проверки S3 на этой регрессии устранён. Согласованный оператором итоговый отчёт Threads успешно передан в S6; первоначальный отказ межчатовой проверки не обходился.

Итоговый рабочий npm test: 525/525, test:bot 143/143. Vault:615 заметок,2737 связей,0 висячих. Doctor exit1: шесть прежних локально отсутствующих настроек IG relay/media-S3 и пять юридических пунктов; это не новый живой отказ внешнего S3. Приём клиентских заявок остаётся закрытым. Новая intake/manual версия ещё не установлена, cloud relay не обновлён, новый host/Task не включён; успешные тесты не заменяют эти шаги и реальный ACK редактора.

## Последующая штатная установка

После этого снимка собственные изменения сохранены точечными коммитами456279b (полная ручная доставка),0f71d2a (approved-media/manual route/YouTube preflight),b3a5bb5 (CLI/dispatch/control),88de626 (акты). Из чистого checkout88de626 штатный deploy прошёл515/515 закоммиченных тестов и установил **88de626 20261110-095733**; один предусмотренный deploy restart и успешный health. Рабочие525 включают дополнительные чужие локальные тесты; они не попали в установку. Cloudflare Worker обновлён из того же чистого кода, version16d3183b-5fa4-488a-8a24-f760da31f5d9, origin ecopolisgo.ru. Внешний health200; заведомо несуществующий неодобренный mediaId даёт404 напрямую и через релей.

После установки: activeMaterials0, legacy/v2jobs0; Threads2skipped, sentdigest1/message318, управляемый cron сохранён. Режим A/новый host/Task **не включены**, старый heartbeat не приостановлен, GitHub10МСК не менялся. Свежий P0 не подделывался: конфликт active-writer и отсутствие реального редакторского ACK сохраняются. Положительный новый клиентский медиавыпуск/YouTube не объявляются проверенными боем; без Одобрить проверочные публикации не создавались. Машиночитаемый акт: `ops/handoff/intake-install-2026-11-10.json`.

Текущий кодовый прогресс10.11 после gap-снимка: manual reply/package получили раздельные durable receipts по сообщениям, known refusal продолжает только недоставленную часть, unknown/legacyheader без доказанного тела удерживается. Приватный YouTube preflight37ba2dc подключён перед resolve/publish, latestextra перечитывается, blocked/unknown возвращает approved без публикации. Профиль16/16PASS (включая beforeapproval0, lostACK,1publish и manualretry); это ещё не установлено. По последней read-only проверке managed daemon сейчас недоступен10061, а не подтверждён работающим. Новый IPC WebSocket-helper пишет только S3; S0 не дублирует его и интегрирует в control после её коммита.
