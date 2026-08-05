#!/usr/bin/env bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Delete Last Note
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🗑️
# @raycast.packageName Inbox Capture

# Documentation:
# @raycast.description Remove the most recent entry from inbox.md. Referenced screenshots go to the Trash, not oblivion.
# @raycast.author MamboMaya

set -euo pipefail

# ---------- CONFIG ----------
INBOX="$HOME/notes/inbox.md"
NOTES_DIR="$HOME/notes"
# ----------------------------

if [ ! -s "$INBOX" ]; then
  echo "Inbox is empty"
  exit 0
fi

# Line number of the last "### " header = start of the most recent entry.
# grep exits 1 if no header line matches — legitimate (e.g. a corrupted or
# manually-edited inbox); the empty check right below reports it.
LAST=$(grep -n '^### ' "$INBOX" | tail -1 | cut -d: -f1 || true)

if [ -z "$LAST" ]; then
  echo "No entries found"
  exit 0
fi

# Grab the block for the confirmation message + asset scan
BLOCK=$(tail -n +"$LAST" "$INBOX")

# Move any referenced screenshots to the Trash (recoverable).
# grep -o exits 1 when the entry has no screenshots — the common case — which
# would otherwise abort the script before the delete below ever runs.
echo "$BLOCK" | grep -o 'inbox-assets/[^)]*' | while read -r REL; do
  [ -f "$NOTES_DIR/$REL" ] && mv "$NOTES_DIR/$REL" "$HOME/.Trash/"
done || true

# Remove the block from the inbox
# BSD sed (macOS-only): -i '' takes the backup-suffix as a separate arg,
# unlike GNU sed's -i''.
sed -i '' "${LAST},\$d" "$INBOX"

# Show a snippet of what was deleted
PREVIEW=$(echo "$BLOCK" | sed -n '2p' | cut -c1-50)
echo "Deleted: ${PREVIEW:-$(echo "$BLOCK" | head -1)}"
