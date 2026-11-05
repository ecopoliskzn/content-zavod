#!/usr/bin/env bash
# Закрытая копия только медиатеки и проверка восстановления в отдельную папку.
# Общая ops/backup.sh уже включает медиатеку в архив DATA; этот проход нужен для
# проверяемого восстановления без чтения заявок, ключей и чужой переписки.
set -euo pipefail
DATA=/opt/ecopolis-data
APP=/opt/ecopolis-zavod/current
OUT=/opt/ecopolis-backup
if [[ "$(id -u)" == "0" ]]; then echo 'Run as zavod, not root' >&2; exit 2; fi
[[ -s "$DATA/media-library/index.json" && -s "$DATA/.backup-pass" ]] || { echo 'Library or encryption password missing' >&2; exit 2; }
mkdir -p "$OUT"
umask 077
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE="$OUT/media-library-$STAMP.tar.gz.enc"
tar -czf - -C "$DATA" media-library | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$DATA/.backup-pass" -out "$ARCHIVE"
RESTORE_CHECK="$(mktemp -d "$DATA/.restore-media.XXXXXXXX")"
[[ "$RESTORE_CHECK" == "$DATA/.restore-media."* ]] || exit 2
trap 'rm -rf -- "$RESTORE_CHECK"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$DATA/.backup-pass" -in "$ARCHIVE" | tar -xzf - -C "$RESTORE_CHECK"
cd "$APP"
DATA_DIR="$RESTORE_CHECK" /usr/bin/node src/media/upload.mjs --audit
echo 'Encrypted library snapshot and isolated restoration verified; external S3 copy is a separate check.'
