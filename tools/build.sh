#!/usr/bin/env bash
# Concatenate src/ into two deployable pages:
#   public/index.html   the game
#   public/editor.html  the content editor
# Both share src/02-core.js (helpers + storage) and src/03-content.js (the
# authored database). The parts are plain fragments, not modules — order is
# significant and is spelled out below rather than left to a glob.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
mkdir -p "$root/public"

GAME_PARTS=(
  src/01-head.html
  src/02-core.js
  src/03-content.js
  src/04-data.js
  src/05-atlas.js
  src/06-world.js
  src/07-ui.js
  src/08-combat.js
  src/09-dev.js
  src/10-tail.html
)

EDITOR_PARTS=(
  editor/01-head.html
  src/02-core.js
  src/03-content.js
  editor/02-app.js
  src/10-tail.html
)

# Everything between the opening and closing <script> tags, for node --check.
check_js () {                       # $1.. = parts, minus head and tail
  local tmp; tmp="$(mktemp)".js
  local p
  for p in "$@"; do cat "$root/$p" >> "$tmp"; done
  if command -v node >/dev/null 2>&1; then
    node --check "$tmp" || { echo "build: JavaScript syntax error, nothing written" >&2; rm -f "$tmp"; exit 1; }
  fi
  rm -f "$tmp"
}

build_page () {                     # $1 = output name, $2.. = parts
  local out="$root/public/$1"; shift
  local parts=("$@")
  # all parts except the first (head) and last (tail) are JavaScript
  check_js "${parts[@]:1:${#parts[@]}-2}"
  : > "$out"
  local p
  for p in "${parts[@]}"; do cat "$root/$p" >> "$out"; done
  echo "  $(basename "$out")  $(wc -c < "$out" | tr -d ' ') bytes"
}

echo "built:"
build_page index.html  "${GAME_PARTS[@]}"
build_page editor.html "${EDITOR_PARTS[@]}"
