#!/bin/bash
# Full-resolution screenshot of the game via headless Chrome (WebGL through SwiftShader).
# Self-hosts a temporary static server, so it works standalone.
# usage: tools/shot.sh "<query string>" out.png [width] [height] [virtual_ms]
#   e.g. tools/shot.sh "hero=fp&floor=1&nosave=1&do=0.8:HM.Input.lastPress.skill1%3DHM.Input.now" /tmp/a.png
#   'do' = '|'-separated list of t:js  (t = seconds of game real-time after boot). URL-encode '=' as %3D, '&' as %26.
#   ALWAYS add sim=<seconds> (e.g. sim=1.2): headless Chrome barely ticks rAF, so the game fast-forwards deterministically
#   to that time at boot (running the do= actions on schedule) and freezes there.
Q="$1"; OUT="$2"; W="${3:-1400}"; H="${4:-820}"; MS="${5:-3000}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=$(( 9100 + RANDOM % 800 ))
node "$DIR/tools/serve.js" $PORT >/dev/null 2>&1 &
SPID=$!
sleep 0.4
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMPD=$(mktemp -d)
"$CHROME" --headless=new --disable-gpu-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --hide-scrollbars \
  --user-data-dir="$TMPD" --window-size="$W,$H" --virtual-time-budget="$MS" --run-all-compositor-stages-before-draw \
  --screenshot="$OUT" "http://127.0.0.1:$PORT/?$Q" >/dev/null 2>&1
kill $SPID 2>/dev/null
rm -rf "$TMPD"
[ -f "$OUT" ] && echo "saved $OUT" || echo "FAILED"
