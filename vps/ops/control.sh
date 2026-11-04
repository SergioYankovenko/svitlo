#!/bin/bash
set -euo pipefail
# Explicit operator action, protected by the same lock used by release deployment.
if test "${ARC_LOCK_HELD:-0}" = 1;then
 flock -n 9
else
 exec 9>/var/lock/svitlo-private-deploy.lock
 flock -n 9
fi
target=$(readlink -f "${1:?release directory required}")
expected=$(readlink -f "${2:?expected current release required}")
case "$target" in /opt/svitlo/staging/releases/*) ;; *) exit 1;; esac
case "$expected" in /opt/svitlo/staging/releases/*) ;; *) exit 1;; esac
test "$(readlink -f /opt/svitlo/staging/current)" = "$expected"
test -f "$target/manifest.json"
slot=a;grep -q 'proxy_pass http://127.0.0.1:18766;' /etc/nginx/conf.d/svitlo-staging.conf && slot=b
cd "$target"
compose=(docker compose --env-file vps/release.env -f vps/compose.yaml)
"${compose[@]}" up -d "api-$slot"
port=18766;test "$slot" = a || port=18767
for i in $(seq 1 30);do if curl -fsS --max-time 5 -H 'Host: localhost:18765' "http://127.0.0.1:$port/readyz" >/dev/null;then break;fi;sleep 1;done
python3 "$expected/vps/ops/switch.py" "$target" "$slot" "$expected"
if ! "${compose[@]}" up -d worker;then
 cd "$expected"
 oldcompose=(docker compose --env-file vps/release.env -f vps/compose.yaml)
 oldslot=a;test "$slot" = b || oldslot=b
 "${oldcompose[@]}" up -d "api-$oldslot"
 python3 vps/ops/switch.py "$expected" "$oldslot" "$target"
 "${oldcompose[@]}" up -d worker
 exit 1
fi
printf 'ARC_CONTROL_COMPLETE\n'
