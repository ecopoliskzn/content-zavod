# S0 → S2: SSH и импорт карусели восстановлены

05.11.2026. Доступ работает из доверенного профиля оператора. Причина отказа в изолированном запуске: SSH использовал C:\Windows\.ssh\known_hosts вместо C:\Users\ecopolis\.ssh\known_hosts. Не менялись ключи сервера, known_hosts, StrictHostKeyChecking и публикации. Проверка из профиля оператора показывает StrictHostKeyChecking=true, identityfile ~/.ssh/ecopolis_operator_ed25519. Доверенный ED25519: SHA256:d59rq+dNzQHzTnjmE1pslTUdWEeDWDyfYQCa15ag0Nk, совпадает с ранее подтверждённым оператором.

В Codex сетевые команды запускаются с разрешением выхода из изоляции (exec_command sandbox_permissions=require_escalated). Это использует штатный профиль Windows ecopolis, а не отключает проверку ключа. Не копируйте приватный SSH-ключ в проект и не используйте StrictHostKeyChecking=no. В обычном PowerShell оператора:

```powershell
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes zavod@104.171.136.64 'cd /opt/ecopolis-zavod/current && node src/media/upload.mjs --status'
```

Сначала сверены SHA256 четырёх исходников из каталога S2 с уже зарегистрированными оригиналами. Все совпали. Повторно оригиналы не создавались. Затем закрыто импортированы четыре готовых PNG 01..04, каждый с ролью publication, parent своего оригинала и variant=instagram-carousel. Порядок исходников 4→3→2→1. Новый публичный доступ PNG не включался.

Готовый манифест: C:\ecopolis-zavod\content\reports\media\2026-11-05\salavat-carousel-library.json. Для записи взять только media.map(({type,mediaId})=>({type,mediaId})), material=case:salavat-kupere-2026-10. caption.txt и визуалы не правились. Итоговый audit: ok=true, verified=12, failedIds=[]; 4 оригинала, 8 версий, 5 502 085 уникальных байт.

Пример повторяемой команды для первого кадра (возвратит тот же ID, если байты те же):

```powershell
npm run media -- --import="C:/Users/ecopolis/Documents/Codex/2026-10-13/new-chat/outputs/salavat-kupere-2026-11-05/carousel/upload-ready-text/01.png" --material=case:salavat-kupere-2026-10 --role=publication --parent=med_9a107fb28cb24f5a87bd32391b211e85 --variant=instagram-carousel --server=zavod@104.171.136.64
```

ops/MEDIA-LIBRARY-STATUS.md существует в текущем общем каталоге, серверная версия aa8c511. Общий deploy/restart в рамках этого поручения не выполнялся. S0 не запускала queue add/submit, не меняла текст и не публиковала. S2 продолжает штатное согласование; HOLD сохраняется. Нативное превью берёт закрытый файл байтами, но для последующего выпуска именно новых PNG ещё нужен подключённый приватный S3 или отдельное разрешение их конкретных URL: прежнее разрешение распространялось на четыре исходных JPG, а не автоматически на новые PNG.
