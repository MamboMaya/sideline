#!/usr/bin/env bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Voice Note (Toggle)
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🎙️
# @raycast.packageName Inbox Capture

# Documentation:
# @raycast.description Press once to start recording, press again to stop, transcribe locally, and append to your inbox.
# @raycast.author MamboMaya

set -euo pipefail

# ---------- CONFIG ----------
INBOX="$HOME/notes/inbox.md"
# Sideline's app config; the ONLY key this script reads is `dictionary`
# (transcription vocabulary, shared with the in-app recorder — see
# docs/data-model.md). Missing file / no jq = built-in vocabulary only.
SIDELINE_CONFIG="$HOME/notes/.sideline.json"
MODEL="$HOME/.whisper-models/ggml-base.en.bin"   # see README for download
WHISPER_BIN="$(command -v whisper-cli || echo /opt/homebrew/bin/whisper-cli)"
FFMPEG_BIN="$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)"
# avfoundation audio device index. 0 is usually the built-in mic — prefer it
# over AirPods/Bluetooth, which can add latency and drop words. Override
# with SIDELINE_AUDIO_DEVICE. List available devices with:
#   ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -A10 "audio devices"
AUDIO_DEVICE="${SIDELINE_AUDIO_DEVICE:-0}"
# ----------------------------

PIDFILE="/tmp/raycast-voice-note.pid"
AUDIO="/tmp/raycast-voice-note.wav"

mkdir -p "$(dirname "$INBOX")"

# ---- STOP + TRANSCRIBE (second press) ----
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  # ffmpeg may already be gone (crashed, killed externally) — that's fine,
  # we still want to proceed to finalize/transcribe whatever it wrote.
  kill -INT "$PID" 2>/dev/null || true

  # wait (max ~5s) for ffmpeg to finalize the file
  for _ in $(seq 1 50); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done
  rm -f "$PIDFILE"

  if [ ! -s "$AUDIO" ]; then
    echo "No audio captured"
    exit 1
  fi

  # User dictionary from .sideline.json: one TSV line per term —
  # `term<TAB>mishear<TAB>mishear…` (a term may have no mis-hearings). Terms
  # are appended to whisper's --prompt to bias spelling; mis-hearings become
  # the correction pass below. Same tolerance as the in-app reader: a
  # missing/malformed file or key just means an empty dictionary.
  DICT_TSV=""
  if [ -f "$SIDELINE_CONFIG" ] && command -v jq >/dev/null 2>&1; then
    DICT_TSV=$(jq -r '(.dictionary // {}) | to_entries[]
      | select(.key | test("\\S"))
      | [.key] + [.value[]? | strings | select(test("\\S"))]
      | @tsv' "$SIDELINE_CONFIG" 2>/dev/null || true)
  fi
  PROMPT="Claude, Claude Code, Sideline, Raycast, Tauri, triage, inbox"
  if [ -n "$DICT_TSV" ]; then
    PROMPT="$PROMPT, $(printf '%s\n' "$DICT_TSV" | cut -f1 | paste -sd, - | sed 's/,/, /g')"
  fi

  # grep -v exits 1 when it filters out every line (i.e. transcription came
  # back blank) — that's an expected outcome here, not a failure; the empty
  # check right below is what reports it.
  TEXT=$("$WHISPER_BIN" -m "$MODEL" -f "$AUDIO" -nt -np \
    --prompt "$PROMPT" 2>/dev/null \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' || true)

  if [ -z "$TEXT" ]; then
    echo "Transcription came back empty"
    exit 1
  fi

  # Whisper often mis-hears "Claude" as "clod"/"claw(ed)"/"clawd"/"clode".
  # Fix only safe, unambiguous patterns; leave real words ("claw", "clawed"
  # on their own) untouched. Then the user dictionary: each term's
  # mis-hearings → the term, whole words, case-insensitive, literal
  # (quotemeta), interior whitespace matching any spacing. The TSV goes in
  # via the environment so no user text is ever interpolated into the perl
  # source.
  TEXT=$(echo "$TEXT" | SIDELINE_DICT="$DICT_TSV" perl -pe '
    BEGIN {
      for (split /\n/, $ENV{SIDELINE_DICT} // "") {
        my ($term, @mis) = split /\t/;
        next unless defined $term && @mis;
        my $alt = join "|", map { join "\\s+", map { quotemeta } split " " } @mis;
        push @rules, [qr/\b(?:$alt)\b/i, $term];
      }
    }
    s/\b(?:clod|claw|clawed|clawd|clode)\s+code\b/Claude Code/gi;
    s/\b(?:clod|clawd|clode)\b/Claude/gi;
    for my $r (@rules) { s/$r->[0]/$r->[1]/g; }
  ')

  {
    echo ""
    echo "### 🎙️ $(date '+%Y-%m-%d %H:%M')"
    echo "$TEXT"
  } >> "$INBOX"

  rm -f "$AUDIO"
  echo "Saved: ${TEXT:0:60}"
  exit 0
fi

# ---- START RECORDING (first press) ----
if [ ! -x "$FFMPEG_BIN" ]; then
  echo "ffmpeg not found — brew install ffmpeg"
  exit 1
fi

if [ ! -x "$WHISPER_BIN" ]; then
  echo "whisper-cli not found — brew install whisper-cpp"
  exit 1
fi

if [ ! -f "$MODEL" ]; then
  echo "Whisper model not found at $MODEL — see README for download"
  exit 1
fi

rm -f "$AUDIO"
nohup "$FFMPEG_BIN" -hide_banner -loglevel error \
  -f avfoundation -i ":${AUDIO_DEVICE}" -ar 16000 -ac 1 -y "$AUDIO" \
  >/dev/null 2>&1 &

echo $! > "$PIDFILE"
echo "🔴 Recording… press again to stop"
