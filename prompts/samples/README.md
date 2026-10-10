# Образцы

По образцу на каждый вид работы. Сессия открывает нужный образец перед тем, как писать, и держит его рядом: в нём каркас, разобранный пример, что остановит проверка и на чём чаще всего ошибаются.

Все примеры собраны из фактов сайта клиента. Каждая цифра в них сверена со статьёй 10.10.2026.

## Тексты

| Образец | Сессия | Готовая запись |
|---|---|---|
| `prompts/samples/статья-в-ветку.md` | S1 | `prompts/samples/entries/threads-vyrubki-14-tochek.json` |
| `prompts/samples/пост-telegram.md` | S1 | `prompts/samples/entries/telegram-zamechanie-v-akte.json` |
| `prompts/samples/пост-вконтакте.md` | S1 | `prompts/samples/entries/vk-shkola-30-osnovanie.json` |
| `prompts/samples/статья-дзен.md` | S1 | `prompts/samples/entries/dzen-gde-otslaivaetsya.json` |
| `prompts/samples/новость-в-заметку.md` | S4, S1 | |
| `prompts/samples/интервью-с-собственником.md` | S1 | |

## Видео

| Образец | Сессия | Готовая запись |
|---|---|---|
| `prompts/samples/сценарий-ролика.md` | S2 | |
| `prompts/samples/описание-youtube.md` | S2 | `prompts/samples/entries/youtube-vyrubki-do-osnovaniya.json` |
| `prompts/samples/подпись-instagram.md` | S2 | `prompts/samples/entries/instagram-vyrubki-do-osnovaniya.json` |
| `prompts/samples/серии-youtube.md` | S2 | |
| `prompts/samples/сценарий-разбора-объекта.md` | S2 | |
| `prompts/samples/задание-на-съёмку.md` | S2 | |

Запись для Rutube с суммами работ: `prompts/samples/entries/rutube-shkola-30-osnovanie.json`.

## Бот, заявки, комментарии

| Образец | Сессия | Готовая запись |
|---|---|---|
| `prompts/samples/кодовое-слово-бота.md` | S3 | |
| `prompts/samples/ответ-на-комментарий.md` | S6 | `prompts/samples/entries/reply-youtube-tolshhina-pod-kacheli.json` |

Рассылка в боте: `prompts/samples/entries/bot-rassylka-zamechanie.json`.

## Темы, цифры, порядок

| Образец | Сессия |
|---|---|
| `prompts/samples/банк-тем.md` | S4 |
| `prompts/samples/недельный-разбор.md` | S5 |
| `prompts/samples/фактчек.md` | все, кто пишет |
| `prompts/samples/задание-исполнителю.md` | оператор |

## Образцы записей проверяются тестом

Каждый файл в `prompts/samples/entries/` проходит форму и все пять проверок без единого замечания: `test/project.test.mjs`. Образец, который сам не прошёл бы на согласование, учил бы писать плохо.

Правка правил в `src/gates/rules.mjs` может сломать образец. Это не помеха, а сигнал: либо правило задело хороший текст, либо образец пора переписать.

## Как завести новый образец

1. Написать настоящий материал по настоящему источнику, а не пример «для формы».
2. Сверить каждую цифру: `prompts/samples/фактчек.md`.
3. Положить запись в `prompts/samples/entries/`, имя `<площадка>-<имя записи>.json`.
4. Описать рядом каркас и то, чего в тексте нет и почему.
5. `npm test`.

В адресах ссылок образцов стоит `go.ecopolisrf.ru`: это адрес завода по плану. Настоящие ссылки собирает команда `npm run link`.
