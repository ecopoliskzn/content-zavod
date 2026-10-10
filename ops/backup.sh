#!/usr/bin/env bash
# Резервная копия каталога данных завода. Cron на сервере раз в сутки.
#
# В каталоге данных лежат заявки и подписчики бота, поэтому копия:
#  · шифруется (openssl, пароль из файла /opt/ecopolis-data/.backup-pass, права 600);
#  · остаётся в России: на этом сервере и в приватном бакете хранилища (BACKUP_S3_*);
#  · на сервере хранится 14 дней, старше удаляется.
# На компьютер оператора и за границу копия не уезжает.
#
# Копия, о провале которой никто не узнал, хуже её отсутствия: на неё рассчитывают.
# Поэтому любая ошибка здесь уходит тревогой в рабочую группу.

set -euo pipefail

APP=/opt/ecopolis-zavod/current
DATA=/opt/ecopolis-data
OUT=/opt/ecopolis-backup
PASS="$DATA/.backup-pass"
NODE=/usr/bin/node
STAMP="$(date -u +%Y%m%d)"
FILE="$OUT/zavod-data-$STAMP.tar.gz.enc"

export ZAVOD_ENV_FILE="$DATA/.env"
export DATA_DIR="$DATA"

fail() {
  "$NODE" "$APP/ops/backup-upload.mjs" --alert "$1" || true
  exit 2
}
trap 'fail "сбой на шаге архивации (строка $LINENO)"' ERR

mkdir -p "$OUT"
[[ -s "$PASS" ]] || fail "нет файла с паролем копии ($PASS)"

tar -C "$DATA" --exclude='.backup-pass' --exclude='*.lock' -czf - . \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$PASS" -out "$FILE"

find "$OUT" -name 'zavod-data-*.tar.gz.enc' -mtime +14 -delete
echo "$(date -u +%FT%TZ) копия сделана: $(du -h "$FILE" | cut -f1)"

# Выгрузка в приватный бакет и проверка, что архив не пустой. О своих сбоях скрипт
# сообщает сам, поэтому ловушку снимаем: двух тревог об одном не нужно.
trap - ERR
"$NODE" "$APP/ops/backup-upload.mjs" "$FILE"

# Восстановление (на сервере, под пользователем zavod, сервис остановлен):
#   openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/opt/ecopolis-data/.backup-pass \
#     -in zavod-data-ГГГГММДД.tar.gz.enc | tar -xz -C /opt/ecopolis-data
#
# Пароль копии хранится ещё в одном месте вне сервера: у ответственного клиента за
# персональные данные. Без пароля архив не открыть никому, в том числе исполнителю.
# В архив попадает и файл окружения с ключами площадок: он нужен, чтобы поднять завод
# на новом сервере, и защищён тем же шифрованием.
