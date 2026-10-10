#!/usr/bin/env bash
# Резервная копия каталога данных завода. Cron на сервере раз в сутки.
#
# В каталоге данных лежат заявки и подписчики бота, поэтому копия:
#  · шифруется (openssl, пароль из файла /opt/ecopolis-data/.backup-pass, права 600);
#  · остаётся в России: на этом же сервере и в бакете хранилища того же поставщика;
#  · хранится 14 дней, старше удаляется.
# На компьютер оператора и за границу копия не уезжает.

set -euo pipefail

DATA=/opt/ecopolis-data
OUT=/opt/ecopolis-backup
PASS="$DATA/.backup-pass"
STAMP="$(date -u +%Y%m%d)"

mkdir -p "$OUT"
if [[ ! -s "$PASS" ]]; then
  echo "$(date -u +%FT%TZ) нет файла с паролем копии ($PASS): копия не сделана" >&2
  exit 2
fi

tar -C "$DATA" --exclude='.backup-pass' --exclude='*.lock' -czf - . \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$PASS" -out "$OUT/zavod-data-$STAMP.tar.gz.enc"

find "$OUT" -name 'zavod-data-*.tar.gz.enc' -mtime +14 -delete
echo "$(date -u +%FT%TZ) копия сделана: $(du -h "$OUT/zavod-data-$STAMP.tar.gz.enc" | cut -f1)"

# Восстановление:
#   openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/opt/ecopolis-data/.backup-pass \
#     -in zavod-data-ГГГГММДД.tar.gz.enc | tar -xz -C /opt/ecopolis-data
