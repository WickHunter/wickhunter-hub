#!/usr/bin/env bash
# scripts/backup-data.sh — back up the hub's data/ directory to a timestamped,
# owner-only-readable tarball, and prune old backups down to a fixed count.
#
# Usage:
#   scripts/backup-data.sh [DATA_DIR] [BACKUP_DIR]
# Defaults: DATA_DIR = $HUB_DATA_DIR, or <repo>/data if unset.
#           BACKUP_DIR = $HUB_BACKUP_DIR, or <repo>/backups if unset.
# Keep count: $HUB_BACKUP_KEEP (default 14 — roughly two weeks on a daily cron).
#
# Every issued token, every activation/audit ledger, the billing config, the
# candle/lease/market-data signing keys — everything that makes this Hub THIS
# Hub — lives under data/ (see README "Where the data lives (and backup)" for
# what each file's loss means). This is the one script meant to run
# unattended on a timer (cron or a systemd timer unit); it never touches
# anything outside DATA_DIR/BACKUP_DIR and it never deletes or modifies
# DATA_DIR itself — only reads it.
set -Eeuo pipefail

say() { printf '   + %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DATA_DIR=${1:-${HUB_DATA_DIR:-$HERE/data}}
BACKUP_DIR=${2:-${HUB_BACKUP_DIR:-$HERE/backups}}
KEEP=${HUB_BACKUP_KEEP:-14}

printf '%s' "$KEEP" | grep -Eq '^[0-9]+$' || die "HUB_BACKUP_KEEP must be a non-negative integer, got: $KEEP"
[ "$KEEP" -ge 1 ] || die "HUB_BACKUP_KEEP must keep at least 1 backup, got: $KEEP"

[ -d "$DATA_DIR" ] || die "data directory does not exist: $DATA_DIR"
# Refuse rather than write a partial or empty tarball that LOOKS like a
# backup and cannot be restored from — a script that refuses to run is
# strictly safer than one that silently produces something unusable.
[ -r "$DATA_DIR" ] && [ -x "$DATA_DIR" ] \
  || die "the current user cannot read/traverse $DATA_DIR — run this as the hub's service user (or root)"
unreadable=$(find "$DATA_DIR" -type f ! -readable -print -quit 2>/dev/null || true)
[ -z "$unreadable" ] || die "$unreadable is not readable by the current user — refusing a partial backup"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$BACKUP_DIR/wickhunter-hub-data-$STAMP.tar.gz"
[ ! -e "$OUT" ] || die "a backup for this exact second already exists: $OUT (re-run a moment later)"

TMP=$(mktemp "$BACKUP_DIR/.backup-$STAMP.XXXXXX")
trap 'rm -f "$TMP"' EXIT

# The archive's CONTENT is only ever what tar itself controls (owner/mode
# bits round-trip as recorded); the archive FILE's own mode is set explicitly
# below, because `tar` does not narrow that for you and data/ is nothing but
# signing keys, licence tokens and audit ledgers — never left group/other
# readable, on disk or packed into a .tar.gz sitting next to it.
tar -czf "$TMP" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
chmod 600 "$TMP"
mv "$TMP" "$OUT"
trap - EXIT
say "wrote $(basename "$OUT") ($(wc -c < "$OUT" | tr -d ' ') bytes)"

# Prune: keep the newest KEEP, delete the rest. Sorting the FILENAME is
# enough — the YYYYMMDDTHHMMSSZ stamp sorts lexically identical to
# chronological order, so this needs no mtime comparison and survives a
# backup directory whose mtimes were reset by a copy/restore.
mapfile -t all < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'wickhunter-hub-data-*.tar.gz' | sort)
total=${#all[@]}
if [ "$total" -gt "$KEEP" ]; then
  remove=$((total - KEEP))
  for ((i = 0; i < remove; i++)); do
    say "pruning $(basename "${all[$i]}")"
    rm -f "${all[$i]}"
  done
fi

mapfile -t kept < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'wickhunter-hub-data-*.tar.gz' | sort)
printf 'kept %s of %s backup(s), newest first:\n' "${#kept[@]}" "$KEEP"
for ((i = ${#kept[@]} - 1; i >= 0; i--)); do printf '  %s\n' "$(basename "${kept[$i]}")"; done
