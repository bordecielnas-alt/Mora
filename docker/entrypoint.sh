#!/bin/sh
# Prépare /data puis lance Mora avec l'utilisateur PUID:PGID (99:100 par défaut, comme Unraid).
set -e
mkdir -p "$MORA_DATA_DIR"
if [ "$(id -u)" = "0" ] && [ "${PUID:-0}" != "0" ]; then
  chown -R "$PUID:$PGID" "$MORA_DATA_DIR" 2>/dev/null || true
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi
exec "$@"
