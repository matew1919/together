#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
export PATH="$PWD/.data/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  print -u2 'Установи Node.js 20+ и снова открой этот файл.'
  exit 1
fi
exec node share.mjs --open
