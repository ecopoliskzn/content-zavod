#!/usr/bin/env bash
# Выкладка кода на сервер завода. Запускается с компьютера оператора (Git Bash):
#   bash ops/deploy.sh zavod@<адрес сервера>
#
# Что делает: тесты → архив закоммиченного кода → новая папка версии на сервере →
# проверка синтаксиса там же → переключение ссылки current → перезапуск → проверка /health.
#
# Раскладка на сервере:
#   /opt/ecopolis-zavod/releases/<время>-<версия>/   код версии
#   /opt/ecopolis-zavod/current                      ссылка на рабочую версию
#   /opt/ecopolis-data/                              данные и файл окружения: выкладка их не трогает
#
# ПРАВИЛА (каждое уже стоило нам сорванной выкладки):
#  · код выхода не глотается: вывод этой команды нельзя пускать через пайп (| tee, | tail),
#    иначе провал выглядит успехом;
#  · выкладывается только закоммиченное: незакоммиченная правка на сервер не уедет, и
#    скрипт скажет об этом до начала;
#  · прошлые версии остаются на сервере: откат — одна команда в конце вывода.

set -euo pipefail

TARGET="${1:-}"
APP=/opt/ecopolis-zavod
PARTS=(src packages ops bot legal zavod.config.json package.json)
if [[ -z "$TARGET" ]]; then
  echo "кому выкладывать: bash ops/deploy.sh zavod@<адрес сервера>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain -- "${PARTS[@]}")" ]]; then
  echo "есть незакоммиченные правки в коде: на сервер уедет только закоммиченное." >&2
  git status --short -- "${PARTS[@]}" >&2
  echo "закоммитьте их или уберите, затем повторите." >&2
  exit 1
fi

echo "1/5 тесты"
if ! node --test test/*.test.mjs > /tmp/zavod-tests.log 2>&1; then
  tail -30 /tmp/zavod-tests.log >&2
  echo "тесты не прошли: выкладка остановлена" >&2
  exit 1
fi

REV="$(git rev-parse --short HEAD)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
echo "2/5 архив версии $REV"
git archive --format=tar.gz -o "/tmp/zavod-$REV.tar.gz" HEAD "${PARTS[@]}"

echo "3/5 доставка"
scp -q "/tmp/zavod-$REV.tar.gz" "$TARGET:/tmp/zavod-$REV.tar.gz"

echo "4/5 переключение и перезапуск"
ssh "$TARGET" bash -s -- "$REV" "$STAMP" "$APP" <<'REMOTE'
set -euo pipefail
REV="$1"; STAMP="$2"; APP="$3"
REL="$APP/releases/$STAMP-$REV"
mkdir -p "$REL"
tar -xzf "/tmp/zavod-$REV.tar.gz" -C "$REL"
echo "$REV $STAMP" > "$REL/VERSION"
# Проверка до переключения: файл с синтаксической ошибкой не должен стать рабочим.
find "$REL/src" "$REL/ops" -name '*.mjs' -print0 | xargs -0 -n1 node --check
chmod +x "$REL/ops/"*.sh 2>/dev/null || true
readlink -f "$APP/current" > "$APP/.previous" 2>/dev/null || true
ln -sfn "$REL" "$APP/current"
sudo systemctl restart ecopolis-zavod
# Оставляем четыре последние версии, остальное убираем.
ls -d "$APP"/releases/* | sort | head -n -4 | xargs -r rm -rf
rm -f "/tmp/zavod-$REV.tar.gz"
REMOTE

echo "5/5 проверка"
sleep 3
ROLLBACK="ssh $TARGET 'ln -sfn \$(cat $APP/.previous) $APP/current && sudo systemctl restart ecopolis-zavod'"
if ! ssh "$TARGET" "curl -fsS -m 10 http://127.0.0.1:3100/health" > /tmp/zavod-health.json; then
  echo "сервер после выкладки не отвечает. Откат: $ROLLBACK" >&2
  exit 1
fi

echo "выложена версия $REV"
echo "откат, если понадобится: $ROLLBACK"
