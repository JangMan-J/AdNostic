#!/bin/sh
# Rasterizes tools/AdNostic.svg into the extension icons (src/icons/icon{16,32,48,128}.png). Needs rsvg-convert.
# 16 and 32 use a tighter crop of the same artwork so the shield stays readable at toolbar size.
set -e
cd "$(dirname "$0")"
OUT=../src/icons
mkdir -p "$OUT"
sed 's|viewBox="0 0 512 512"|viewBox="22 22 468 468"|' AdNostic.svg > /tmp/adnostic-tight.svg
rsvg-convert -w 16  -h 16  /tmp/adnostic-tight.svg -o "$OUT/icon16.png"
rsvg-convert -w 32  -h 32  /tmp/adnostic-tight.svg -o "$OUT/icon32.png"
rsvg-convert -w 48  -h 48  AdNostic.svg            -o "$OUT/icon48.png"
rsvg-convert -w 128 -h 128 AdNostic.svg            -o "$OUT/icon128.png"
rm -f /tmp/adnostic-tight.svg
echo "icons written to src/icons"
