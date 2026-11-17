#!/usr/bin/env bash
cd -- "$(dirname -- "$0")" || exit 1
node stream-local.mjs
read -r -p 'Нажми Enter, чтобы закрыть…'
