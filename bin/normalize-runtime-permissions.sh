#!/usr/bin/env bash
# Normalize an installed Hub tree after a root build. npm and tsc honour the
# caller's umask; an operator running the installer under 0077 otherwise leaves
# newly compiled files at 0600 and directories at 0700, which the deliberately
# unprivileged systemd service cannot read or traverse.
#
# Durable state is a different trust boundary. data/ holds signing keys and
# releases/ holds licensed artifacts, so both subtrees are pruned completely;
# install-hub.sh separately makes them service-owned and 0700.
set -Eeuo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 1 ] || die "usage: normalize-runtime-permissions.sh HUB_DIR"
[ -d "$1" ] || die "Hub directory does not exist: $1"
HUB_ROOT=$(cd "$1" && pwd -P)
[ "$HUB_ROOT" != "/" ] || die "refusing to normalize the filesystem root"
[ -d "$HUB_ROOT/dist" ] || die "compiled runtime is missing: $HUB_ROOT/dist"

# find does not follow symlinks by default. Every ordinary code/runtime
# directory becomes traversable and every ordinary file becomes readable;
# group/other write bits are removed, while an existing owner execute bit is
# preserved for source scripts.
find "$HUB_ROOT" \
  \( -path "$HUB_ROOT/data" -o -path "$HUB_ROOT/releases" -o -path "$HUB_ROOT/.git" \) -prune -o \
  -type d -exec chmod u+rwx,go+rx,go-w {} +
find "$HUB_ROOT" \
  \( -path "$HUB_ROOT/data" -o -path "$HUB_ROOT/releases" -o -path "$HUB_ROOT/.git" \) -prune -o \
  -type f -exec chmod u+rw,go+r,go-w {} +
