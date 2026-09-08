#!/usr/bin/env bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Link Note
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🔗
# @raycast.packageName Inbox Capture

# Documentation:
# @raycast.description Append the frontmost Google Chrome tab (title + URL) to your inbox.
# @raycast.author MamboMaya

set -euo pipefail

INBOX="$HOME/notes/inbox.md"

mkdir -p "$(dirname "$INBOX")"

# Check via pgrep first — a bare `tell application "Google Chrome"` in
# osascript below would otherwise launch Chrome if it isn't already running.
if ! pgrep -x "Google Chrome" >/dev/null 2>&1; then
  echo "Chrome has no open tab"
  exit 1
fi

RESULT=$(osascript <<'EOF'
tell application "Google Chrome"
  if (count of windows) = 0 then
    return "NO_WINDOW"
  end if
  set theTab to active tab of front window
  return (URL of theTab) & linefeed & (title of theTab)
end tell
EOF
)

if [ "$RESULT" = "NO_WINDOW" ]; then
  echo "Chrome has no open tab"
  exit 1
fi

URL=$(echo "$RESULT" | sed -n '1p')
TITLE=$(echo "$RESULT" | sed -n '2p' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

if [ -z "$URL" ] || [[ "$URL" == chrome://* ]]; then
  echo "Not a web page"
  exit 1
fi

{
  echo ""
  echo "### 🔗 $(date '+%Y-%m-%d %H:%M')"
  if [ -n "$TITLE" ]; then
    echo "$TITLE"
  fi
  echo "$URL"
} >> "$INBOX"

if [ -n "$TITLE" ]; then
  echo "Saved: ${TITLE:0:60}"
else
  echo "Saved: ${URL:0:60}"
fi
