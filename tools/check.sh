#!/bin/sh
#
# Run all four suites headlessly and exit non-zero if any of them failed.
#
#   sh tools/check.sh              every suite
#   sh tools/check.sh switching    only the groups matching that word
#
# Why this exists: the suites are pages, and a page nobody opens is a page that
# goes quietly red. This opens them, in a real browser, past the cache, and
# turns the result into an exit code -- so a commit hook or anything else can
# ask "is it still green" without a person having to look.
#
# It is Chrome and a static server and nothing else. No runner, no driver, no
# node_modules. --virtual-time-budget is what makes it bearable: the suites are
# full of waits, and virtual time fast-forwards every one of them while still
# letting real fetches finish, so a full pass takes seconds rather than minutes.

set -e
cd "$(dirname "$0")/.."

ONLY="${1:-}"
PORT="${COC_TEST_PORT:-8199}"

CHROME=""
for c in \
  "/c/Program Files/Google/Chrome/Application/chrome.exe" \
  "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
  "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe" \
  "$(command -v google-chrome || true)" \
  "$(command -v chromium || true)"
do
  [ -n "$c" ] && [ -f "$c" ] && CHROME="$c" && break
done
if [ -z "$CHROME" ]; then
  echo "check: no Chrome found. Set CHROME=/path/to/chrome and try again." >&2
  exit 2
fi

PY="$(command -v python || command -v python3 || true)"
if [ -z "$PY" ]; then echo "check: no python to serve the folder with." >&2; exit 2; fi

# Served no-store, which is not a detail.
#
# python -m http.server sends no Cache-Control at all, so Chrome caches by
# heuristic and its profile persists between runs. Edit a module, run the hook,
# and the first result can be the previous version of your code passing or
# failing -- which is the single worst thing a check can do, because it is
# indistinguishable from a real answer. Every file is served no-store instead.
"$PY" - "$PORT" >/dev/null 2>&1 <<'SERVE' &
import functools, http.server, os, sys
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(
    ('127.0.0.1', int(sys.argv[1])),
    functools.partial(H, directory=os.getcwd()),
).serve_forever()
SERVE
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT INT TERM

# The server needs a moment, and asking is cheaper than guessing.
i=0
while [ $i -lt 50 ]; do
  curl -sf "http://127.0.0.1:$PORT/index.html" >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 0.2
done

# Its own profile, on E:, because Chrome will not run two instances against one
# and the user's everyday profile is not this script's to touch.
PROFILE="${COC_TEST_PROFILE:-E:/caches/chrome-test-profile}"
mkdir -p "$PROFILE"

FAILED=0
for page in apptest mobiletest chipstest changestest; do
  # perf=off because the virtual clock below makes wall-clock budgets
  # meaningless -- the suites report those as skipped rather than inventing a
  # verdict. Open the page in a browser for the real numbers.
  url="http://127.0.0.1:$PORT/$page.html?perf=off"
  [ -n "$ONLY" ] && url="$url&only=$ONLY"

  title=$("$CHROME" \
    --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" --window-size=1440,960 \
    --virtual-time-budget=900000 --dump-dom "$url" 2>/dev/null \
    | tee "${COC_TEST_DUMP:-/dev/null}${COC_TEST_DUMP:+/$page.html}" \
    | grep -o '<title>[^<]*</title>' | sed 's/<[^>]*>//g' \
    | grep -E '^(ok|FAIL)' | tail -1)

  case "$title" in
    ok:*)   printf '  ok   %-14s %s\n' "$page" "$title" ;;
    FAIL*)  printf '  FAIL %-14s %s\n' "$page" "$title"; FAILED=1 ;;
    *)      printf '  FAIL %-14s never reported (title was "%s")\n' "$page" "$title"; FAILED=1 ;;
  esac
done

if [ "$FAILED" -eq 0 ]; then echo "all suites green"; else echo "SUITES FAILED" >&2; fi
exit "$FAILED"
