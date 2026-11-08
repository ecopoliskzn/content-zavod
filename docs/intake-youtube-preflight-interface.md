# S2 → S0: закрытая загрузка intake YouTube

Модуль `src/video/intake-preflight.mjs`, экспорт `preflightIntakeYoutube(entry, options={})`. Runner вызывает его для сырой записи очереди YouTube video/short с intake identity, до resolveEntryMedia и publish. Никаких модели, нового согласования, Telegram или публикации внутри функции нет. S0 владеет подключением к runner/host и установкой; S2 не менял эти файлы.

```js
const prepared = await preflightIntakeYoutube(rawEntry);
if (prepared.status === 'unmanaged') { /* обычный прежний путь */ }
else if (!prepared.ready) { /* удержать запись, не вызывать publish */ }
else {
  // Перечитать очередь, перепроверить human approval/currentness/рубильники/срок.
  // Затем обычный YouTube publish: он единственный открывает ролик.
}
```

Ответы: `{ok:true,ready:true,status:'ready',entry}` — private без publishAt, актуальные метаданные/обложка подтверждены, queue extra сохранён. `already_public` с ready=true — только восстановление уже открытого ролика при совпадении ранее сохранённой ready-квитанции, текущего согласия, media/cover, хеша и сведений самого YouTube; никаких правок публичного ролика. Нельзя считать любой youtubeId подтверждением текущего содержимого. `{ok:false,ready:false,status:'blocked'|'pending'|'unknown',reason}` — без публикации. Unmanaged не меняет legacy записи и существующие ролики вне intake. Ready не отменяет due/commissioning/STOP/HOLD/RESTORED/YouTube-first и не является самим результатом публикации.

По умолчанию проверяются свежая approved/running запись с approval.at/card/cardHash/actionToken и вычисленным contentHash; native intake publicationBlockers/current target и проверенный job.result. Перед внешними эффектами и записью extra эти проверки повторяются. Основное видео — publication mediaId того же material; cover — publication/cover того же parent. Реальные локальные SHA/bytes сверяются, URL модели не принимаются. Обложки JPEG/PNG до 2 МБ передаются существующему setThumbnail с правильным расширением временного закрытого файла. Подмена/недоступность файла блокирует выпуск.

Загрузка использует тот же YouTube resumable-протокол, что старый upload, но с durable session URI до первого PUT. Непрозрачный старый upload не даёт сохранить session URI между его POST и PUT, поэтому здесь отдельный узкий транспорт с существующим accessToken. Для метаданных, обложки, снятия случайного срока и status используются существующие updateSnippet/setThumbnail/setSchedule/status. Номер и youtubeHash/youtubePublishAt записываются штатным queue.patch с expected fence. Ни privacy public, ни publishAt при загрузке не отправляются.

Реестр `data/youtube-intake-preflight/` закрытый: имя по entry ID/hash видео; JSON и временные обложки mode 0600, каталог 0700. **Не печатать JSON целиком: session URI является закрытым capability.** Замок на entry использует проверку живого PID, а не истечение долгой загрузки по таймеру. Коррумпированная/чужая квитанция не перезаписывается. Фазы prepared → starting → session → sending → uploaded → updating → ready сохраняются до следующего эффекта.

После потерянного ACK upload выполняется пустой PUT той же session URI с Content-Range bytes */size. Ответ с ID восстанавливает единственный ролик; 308 задаёт точное продолжение. После потерянного ACK queue.patch повторно записывается тот же ID. Потерянный Location/неизвестный POST либо истёкшая session удерживаются как unknown, новый videos.insert автоматически не делается. Известный отказ до старта (нет доступа, HTTP 4xx старта) остаётся prepared/pending и может продолжаться после исправления. Источник протокола: [Google, resumable uploads](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol).

Изменённое и заново одобренное описание того же видео обновляет тот же private ID, затем проверяется фактический snippet и записывается новый youtubeHash. Публичный ролик под новым содержимым не правится. Удаление ранее поставленной собственной обложки удерживается: API удаления обложки здесь нет, молча оставить старую нельзя. Отзыв согласия во время загрузки оставляет только private загрузку и квитанцию, без youtubeHash-ready/публикации.

Options предназначены для S0/изолированных тестов: getEntry/patchEntry (нативная сигнатура store.patch), isCurrent(entry), halted(), catalog(), localPath(row), describe(entry), transport {start,probe,send}, api {status,updateSnippet,setThumbnail,setSchedule}, dir. В production использовать штатные defaults; не подменять проверки готовности константой true. Transport не возвращает session URI из публичного результата preflight. Raw transport start/status тестируются только с синтетическим fetch без сети.

Сопутствующий timing-стык в entryFromIntakeVariant: mode at хранит atISO=t.at и expireAt не позже конца календарной минуты floor(at/60000)*60000+59999; явные t.expireAt/t.deadline берутся только как более ранний предел. S0 учитывает atISO как точную нижнюю границу, включая секунды. Сам preflight срок выхода не назначает.

## Результаты проверки S2

Собственный целевой набор: 16/16 (11 preflight + 5 formats/timing). Регрессия atISO до правки падала; отсутствие модуля и дополнительная проверка запрета public на уровне transport также были воспроизведены до исправления. Транспорт принудительно создаёт private без publishAt даже при ошибочном внешнем status в аргументах.

Общий npm test финальной версии: 502/503, exit1. Единственный отказ media-intake-flow.test.mjs:18 повторён отдельно: CLI claimCurrentIntakeJob сначала вызывает intake-jobs, а синтетический HTTP server этого теста обрабатывает intake-claim/context/question/facts/result, но не intake-jobs и возвращает 500. Тест/CLI/runner принадлежат S0 и не изменялись S2. До исправления этого стыка общий прогон не зелёный. Первый общий прогон также 502/503, тот же отказ.

test:bot 143/143, exit0. doctor exit1: шесть отсутствующих локальных параметров (IG relay и S3), пять юридических предупреждений; клиентский приём закрыт. vault --check exit0: 606 заметок, 2696 связей, 0 висячих ссылок. Ключи/окружение не открывались. Git diff/check собственных файлов сверяется перед коммитом.

Боевые API/ключи/существующие 3V57… и другие публикации не трогались, upload живого файла не проверен. GitHub/push/deploy не выполнялись; наличие модуля не означает подключения runner или установки сервера. Собственные файлы: src/video/intake-preflight.mjs, test/intake-youtube-preflight.test.mjs, этот документ, src/bot/media-intake-delivery.mjs и test/media-intake-formats.test.mjs (только переданный S0 timing-стык).
