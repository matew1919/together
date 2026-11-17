#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
export PATH="$PWD/.data/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Для запуска нужен Node.js 20+. Установи его и запусти файл снова.' >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  printf '%s\n' 'Нужен Node.js версии 20 или новее.' >&2
  exit 1
fi
for dependency in ssh ssh-keygen ffmpeg ffprobe; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf 'Не найдена программа %s. Для Ubuntu установи openssh-client и ffmpeg.\n' "$dependency" >&2
    exit 1
  fi
done
exec node share.mjs --open
