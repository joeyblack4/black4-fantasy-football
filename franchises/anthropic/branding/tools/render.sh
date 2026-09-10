#!/usr/bin/env bash
# Renders the SVG sources in ../logo to PNG in ../png using headless Google Chrome (macOS path).
# Each SVG is wrapped in a minimal HTML page so it scales exactly to the requested pixel size.
# Usage: tools/render.sh   (paths resolve relative to this script; override CHROME=... if needed)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOGO="$HERE/../logo"; OUT="$HERE/../png"; mkdir -p "$OUT"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
render() { # file.svg width height out.png
  local html="$TMP/$(basename "$1" .svg)-$2x$3.html"
  printf '<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block;width:%spx;height:%spx}</style></head><body><img src="file://%s/%s"></body></html>' "$2" "$3" "$LOGO" "$1" > "$html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size="$2,$3" --screenshot="$4" "file://$html" >/dev/null 2>&1
  echo "rendered $(basename "$4") ($2x$3)"
}
render mg-badge.svg 1024 1024 "$OUT/mg-badge-1024.png"
render mg-badge.svg 512 512 "$OUT/mg-badge-512.png"
for s in 512 256 128 64; do render mg-mark.svg $s $s "$OUT/mg-avatar-$s.png"; done
render mg-wordmark-dark.svg 1600 400 "$OUT/mg-wordmark-dark-1600.png"
render mg-wordmark-light.svg 1600 400 "$OUT/mg-wordmark-light-1600.png"
render mg-banner.svg 1500 500 "$OUT/mg-banner-1500x500.png"
