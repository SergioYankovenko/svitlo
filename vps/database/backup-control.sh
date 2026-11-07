#!/bin/bash
set -euo pipefail
umask 077
test "$(cat /etc/svitlo/pgbackrest/.owner)" = ARCH-MOD-01-14
exec 9>/var/lock/svitlo-pgbackrest-backup.lock
flock -n 9
case "${1:-check}" in
  full|diff) docker exec --user postgres svitlo-postgres-1 pgbackrest --stanza=svitlo --type="$1" backup ;;
  check) docker exec --user postgres svitlo-postgres-1 pgbackrest --stanza=svitlo check ;;
  status) docker exec --user postgres svitlo-postgres-1 pgbackrest --stanza=svitlo --output=json info ;;
  *) exit 64 ;;
esac
