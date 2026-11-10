# S3 → S0: транспорт control socket, 10.11.2026

Файлы S3: `ops/codex-proxy-websocket.mjs`, `test/codex-proxy-websocket.test.mjs`, этот контракт. Общие control/host/runtime/runner/deploy не менялись. Реальный managed daemon не перезапускался; пользовательские чаты не читались/не возобновлялись; ReviewWatch marker не отправлялся.

Официальная спецификация: https://learn.chatgpt.com/docs/app-server — control Unix socket использует HTTP Upgrade и WebSocket frames; один JSON-RPC объект на текстовое WebSocket-сообщение, без обязательного поля jsonrpc. Проверены локальные metadata @openai/codex 0.166.0-alpha.6 и `app-server proxy --help`: proxy переносит сырые stdin/stdout bytes. Сам proxy в этой подзадаче с реальным daemon не соединялся.

## Интерфейс

```js
import {openCodexProxyWebSocket} from './codex-proxy-websocket.mjs';
const connection = await openCodexProxyWebSocket(executable, {
  timeoutMs: 30000,
  handshakeTimeoutMs: 5000,
  maxMessageBytes: 262144,
  maxBytes: 2097152,
  maxBufferedBytes: 262144,
  signal, // необязательный AbortSignal
});
const off = connection.onMessage(message => { /* существующий JSON-RPC control S0 */ });
connection.send({id: 1, method: 'initialize', params: {/* clientInfo S0 */}});
// onMessage вызывается для декодированного объекта, не строки/JSONL.
// Свою политику initialize/read/resume, UUID и обработку id сохраняет control S0.
off();
const outcome = await connection.close(); // идемпотентно
// либо await connection.closed при ошибке/таймауте/закрытии удалённой стороны
// outcome = {reason, cleanupComplete}
```

Helper не отправляет ни initialize, ни какого-либо другого RPC автоматически. Не формирует prompt, turn/start, chat/thread create/resume и не задаёт модель. Generic send передаёт объект вызывающего кода; allowlist RPC/UUID остаётся в control S0. send после закрытия бросает PROXY_CLOSED; исходящий лимит — PROXY_SEND_LIMIT без отправки. onMessage возвращает unsubscribe. Ошибка callback закрывает транспорт с listener_error.

До открытия сбой отвергает Promise безопасным Error с code/message `PROXY_<REASON>`, без stderr/исходных системных ошибок. После открытия `closed` всегда разрешается исходом. Reason: closed, timeout, handshake_timeout, spawn, child_closed, stream_error, websocket, socket_closed, byte_limit, invalid_message, message_limit, listener_error, aborted, bridge. Некорректные параметры — PROXY_OPTIONS. Таймаут ограничивает **всё время жизни соединения**, а не только ожидание первого ответа; максимум 60 секунд. maxBytes ограничивает суммарный сырой поток в обе стороны, включая handshake, maxMessageBytes — отдельное JSON-сообщение, maxBufferedBytes — очередь исходящих WebSocket данных. Превышение входного лимита или повреждённый JSON/binary закрывает транспорт.

## Границы и очистка

Только встроенный Node24 WebSocket выполняет HTTP Upgrade, masking и framing, включая фрагментированные сообщения. net bridge слушает 127.0.0.1 на случайном порту; непредсказуемый одноразовый путь проверяется перед передачей каких-либо байтов child и заменяется стандартным `/` в его Upgrade. Чужой путь закрывается. Предел preface 8 KiB, максимум 2 локальных sockets, preface timeout. Listener закрывается сразу при выборе собственного соединения. Нет внешнего listen, remote-control endpoint или постоянного сервиса.

Создаётся только собственный `spawn(executable,['app-server','proxy'],{stdio:['pipe','pipe','ignore'],windowsHide:true,shell:false})`. stderr не читается и не возвращается. При завершении закрываются bridge/listener/sockets/WebSocket, уничтожаются pipe-потоки, завершается только этот proxy child. При отсутствии close после SIGTERM через 100ms вызывается SIGKILL, ещё через 100ms возвращается явный cleanupComplete=false, если ОС не подтвердила завершение. Такой исход S0 обязан считать техническим отказом, не успешной очисткой. Managed daemon не является этим child и не завершается helper. `spawnChild` — тестовая инъекция, production использует node:child_process.spawn.

## Проверено

Сначала изолированный тест упал с ERR_MODULE_NOT_FOUND. После реализации 7/7: настоящий Node WebSocket Upgrade, masked JSON-RPC, fragmented response, повтор close, закрытый listener, invalid Upgrade, handshake timeout, child exit, spawn/stream error, malformed JSON/binary, message/wire/send limits, lifetime, AbortSignal до/после открытия, ошибка listener/unsubscribe, SIGKILL для зависшего child и явный cleanupComplete=false для неподтверждённого exit. RFC6455 peer реализован только в тесте; production собственного encoder/parser кадров не имеет. Реальный handshake с managed daemon и read-only UUID оставлены S0 после интеграции своего control. Эти тесты не подтверждают resume или приём задания редактором.

Общий npm test: 521/522, один отказ в S0 `test/intake-dispatch.test.mjs:46`, «старый queued после общего изменения освобождает очередь только с fenced-current=false»: actual unknown, expected cancelled. Транспортные тесты в общем прогоне прошли; последний дополнительный тест SIGKILL отдельно прошёл после запуска общего прогона. Чужой dispatcher/test не менялись. test:bot 143/143; vault 615 заметок, 0 висячих ссылок; doctor exit=1, прежние 6 отсутствующих локальных настроек relay/S3, client leads закрыт. Полный прогон зелёным не объявляется.
