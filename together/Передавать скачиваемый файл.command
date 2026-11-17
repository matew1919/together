#!/usr/bin/env bash
cd -- "$(dirname -- "$0")" || exit 1
export PATH="$PWD/.data/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
node stream-local.mjs
read -r -p 'Нажми Enter, чтобы закрыть…'
