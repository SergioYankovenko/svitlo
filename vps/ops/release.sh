set -euo pipefail
umask 077
exec 9>/var/lock/svitlo-private-deploy.lock
flock -n 9
release='@@RELEASE@@'
expected='/opt/svitlo/staging/releases/@@EXPECTED@@'
test "$(readlink -f /opt/svitlo/staging/current)" = "$expected"
upload="/home/svitlo-admin/.svitlo-bootstrap/$release"
target="/opt/svitlo/staging/releases/$release"
python3 - "$upload" <<'PY'
import hashlib,json,sys
from pathlib import Path
p=Path(sys.argv[1]);m=json.loads((p/'manifest.json').read_text())
for n,k in [('image.tar.gz','imageSha256'),('source.tar.gz','sourceSha256')]:assert hashlib.sha256((p/n).read_bytes()).hexdigest()==m[k]
assert m['builtOutsideVps'] and m['delivery']=='pilot-enabled'
PY
gzip -dc "$upload/image.tar.gz" | docker load >/dev/null
if test -d "$target";then
 cmp "$upload/manifest.json" "$target/manifest.json"
else
 install -d -m 755 "$target"
 tar -xzf "$upload/source.tar.gz" -C "$target"
 install -m 644 "$upload/manifest.json" "$target/manifest.json"
fi
image=$(python3 -c "import json;print(json.load(open('$target/manifest.json'))['image'])")
test "$(docker image inspect -f '{{.Id}}' "$image")" = "$image"
commit=$(python3 -c "import json;print(json.load(open('$target/manifest.json'))['sourceCommit'])")
test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$commit"
printf 'STAGE_IMAGE=%s\nRELEASE_ID=%s\nSVITLO_PILOT_PUSH=enabled\n' "$image" "$release" > "$target/vps/release.env"
cd "$target"
# Reserve the worker role's connection budget for two-process restored QA.
# Graceful stop finishes the current portion; any failed gate resumes this same container.
discovery_was_running=false
resume_discovery(){ if test "$discovery_was_running" = true;then docker start svitlo-stage-discovery-1 >/dev/null || true;fi; }
if test "$(docker inspect -f '{{.State.Running}}' svitlo-stage-discovery-1 2>/dev/null || true)" = true;then
 discovery_was_running=true
 docker stop -t 90 svitlo-stage-discovery-1 >/dev/null
fi
trap resume_discovery EXIT
/usr/local/sbin/svitlo-stage-backup
backup=$(cat /var/lib/svitlo-stage/latest-backup)
mounts=(--mount type=bind,src=/etc/svitlo/secrets/postgres-owner-password,dst=/run/secrets/owner_password,readonly)
for name in api worker session;do mounts+=(--mount "type=bind,src=/etc/svitlo/stage-secrets/$name-password,dst=/run/secrets/${name}_password,readonly");done
for name in session sensor-access phone;do alias=${name//-/_};mounts+=(--mount "type=bind,src=/etc/svitlo/stage-secrets/$name-secret,dst=/run/secrets/${alias}_secret,readonly");done
for suite in phone history map regions pwa sources subscriptions geography discovery;do
 qa="svitlo_${suite}_qa_$(date +%s)"
 if test "$suite" = regions;then qa="svitlo_kyiv_qa_$(date +%s)";fi
 docker exec svitlo-postgres-1 createdb -U svitlo_owner "$qa"
 trap 'docker exec svitlo-postgres-1 dropdb -U svitlo_owner "$qa" || true; resume_discovery' EXIT
 docker exec -i svitlo-postgres-1 pg_restore --exit-on-error -U svitlo_owner -d "$qa" < "$backup"
 if test -f vps/sql/operations.sql;then
  existing=$(docker exec svitlo-postgres-1 psql -X -U svitlo_owner -d "$qa" -Atc "select sha256 from svitlo_vps.migrations where name='1011_operations.sql'")
  hash=$(sed 's/\r$//' vps/sql/operations.sql | sha256sum | cut -d' ' -f1)
  if test -z "$existing";then
   docker exec -i svitlo-postgres-1 psql -X -q -1 -v ON_ERROR_STOP=1 -U svitlo_owner -d "$qa" < vps/sql/operations.sql
   docker exec svitlo-postgres-1 psql -X -q -U svitlo_owner -d "$qa" -c "insert into svitlo_vps.migrations(name,sha256) values('1011_operations.sql','$hash')"
  else test "$existing" = "$hash";fi
 fi
 if test -f vps/sql/source-history.sql;then
  existing=$(docker exec svitlo-postgres-1 psql -X -U svitlo_owner -d "$qa" -Atc "select sha256 from svitlo_vps.migrations where name='1012_source_history.sql'")
  hash=$(sed 's/\r$//' vps/sql/source-history.sql | sha256sum | cut -d' ' -f1)
  if test -z "$existing";then
   docker exec -i svitlo-postgres-1 psql -X -q -1 -v ON_ERROR_STOP=1 -U svitlo_owner -d "$qa" < vps/sql/source-history.sql
   docker exec svitlo-postgres-1 psql -X -q -U svitlo_owner -d "$qa" -c "insert into svitlo_vps.migrations(name,sha256) values('1012_source_history.sql','$hash')"
  else test "$existing" = "$hash";fi
 fi
 existing=$(docker exec svitlo-postgres-1 psql -X -U svitlo_owner -d "$qa" -Atc "select sha256 from svitlo_vps.migrations where name='1013_pilot_push.sql'")
 hash=$(sed 's/\r$//' vps/sql/pilot-push.sql | sha256sum | cut -d' ' -f1)
 if test -z "$existing";then
  docker exec -i svitlo-postgres-1 psql -X -q -1 -v ON_ERROR_STOP=1 -U svitlo_owner -d "$qa" < vps/sql/pilot-push.sql
  docker exec svitlo-postgres-1 psql -X -q -U svitlo_owner -d "$qa" -c "insert into svitlo_vps.migrations(name,sha256) values('1013_pilot_push.sql','$hash')"
 else test "$existing" = "$hash";fi
 existing=$(docker exec svitlo-postgres-1 psql -X -U svitlo_owner -d "$qa" -Atc "select sha256 from svitlo_vps.migrations where name='1014_main_app_subscription.sql'")
 hash=$(sed 's/\r$//' vps/sql/main-app-subscription.sql | sha256sum | cut -d' ' -f1)
 if test -z "$existing";then
  docker exec -i svitlo-postgres-1 psql -X -q -1 -v ON_ERROR_STOP=1 -U svitlo_owner -d "$qa" < vps/sql/main-app-subscription.sql
  docker exec svitlo-postgres-1 psql -X -q -U svitlo_owner -d "$qa" -c "insert into svitlo_vps.migrations(name,sha256) values('1014_main_app_subscription.sql','$hash')"
 else test "$existing" = "$hash";fi
 existing=$(docker exec svitlo-postgres-1 psql -X -U svitlo_owner -d "$qa" -Atc "select sha256 from svitlo_vps.migrations where name='1015_settlement_directory.sql'")
 hash=$(sed 's/\r$//' vps/sql/settlement-directory.sql | sha256sum | cut -d' ' -f1)
 if test -z "$existing";then
  docker exec -i svitlo-postgres-1 psql -X -q -1 -v ON_ERROR_STOP=1 -U svitlo_owner -d "$qa" < vps/sql/settlement-directory.sql
  docker exec svitlo-postgres-1 psql -X -q -U svitlo_owner -d "$qa" -c "insert into svitlo_vps.migrations(name,sha256) values('1015_settlement_directory.sql','$hash')"
 else test "$existing" = "$hash";fi
 for spec in 1016_phone_qr_rotation.sql:phone-qr-rotation.sql 1018_expired_phone_qr.sql:expired-phone-qr.sql 1019_geography_discovery.sql:geography-discovery.sql 1020_historical_plan.sql:historical-plan.sql 1021_discovery_throughput.sql:discovery-throughput.sql 1022_discovery_territory.sql:discovery-territory.sql;do
  name=${spec%%:*};file=${spec#*:}
  existing=$(docker exec svitlo-postgres-1 psql -X -U svitlo_owner -d "$qa" -Atc "select sha256 from svitlo_vps.migrations where name='$name'")
  hash=$(sed 's/\r$//' "vps/sql/$file" | sha256sum | cut -d' ' -f1)
  if test -z "$existing";then
   docker exec -i svitlo-postgres-1 psql -X -q -1 -v ON_ERROR_STOP=1 -U svitlo_owner -d "$qa" < "vps/sql/$file"
   docker exec svitlo-postgres-1 psql -X -q -U svitlo_owner -d "$qa" -c "insert into svitlo_vps.migrations(name,sha256) values('$name','$hash')"
  else test "$existing" = "$hash";fi
 done
 docker run --rm --network svitlo_backend --user 0 -e PGDATABASE="$qa" "${mounts[@]}" --entrypoint node "$image" vps/geography/prepare-qa.mjs
 if test "$suite" = phone;then docker exec svitlo-postgres-1 psql -X -q -v ON_ERROR_STOP=1 -U svitlo_owner -d "$qa" -c 'truncate svitlo_sensors.phone_ranges';fi
 if test "$suite" = regions;then docker exec svitlo-postgres-1 psql -X -q -U svitlo_owner -d "$qa" -c 'truncate public.svitlo_source_cache';fi
 case "$suite" in phone) script=vps/sensors/phone-integration.mjs;;history) script=vps/sensors/history-integration.mjs;;map) script=vps/maps/integration.mjs;;regions) script=vps/regions/integration.mjs;;pwa) script=vps/department-integration.mjs;;sources) script=vps/regions/source-history-integration.mjs;;subscriptions) script=vps/sensors/subscription-integration.mjs;;geography) script=vps/geography/integration.mjs;;discovery) script=vps/discovery/integration.mjs;;esac
 docker run --rm --network svitlo_backend --user 0 -e PGDATABASE="$qa" "${mounts[@]}" --entrypoint node "$image" "$script"
 if test "$suite" = phone;then docker run --rm --network svitlo_backend --user 0 -e PGDATABASE="$qa" "${mounts[@]}" --entrypoint node "$image" vps/sensors/qr-rotation-integration.mjs;fi
 docker exec svitlo-postgres-1 dropdb -U svitlo_owner "$qa"
 trap resume_discovery EXIT
done
compose=(docker compose --env-file vps/release.env -f vps/compose.yaml)
"${compose[@]}" run --rm --user 0 migrate
slot=a
if grep -q 'proxy_pass http://127.0.0.1:18766;' /etc/nginx/conf.d/svitlo-staging.conf;then slot=b;fi
"${compose[@]}" up -d "api-$slot"
port=18766;test "$slot" = a || port=18767
for i in $(seq 1 30);do if curl -fsS --max-time 5 -H 'Host: localhost:18765' "http://127.0.0.1:$port/readyz" >/dev/null;then break;fi;sleep 1;done
test "$(readlink -f /opt/svitlo/staging/current)" = "$expected"
ARC_LOCK_HELD=1 bash vps/ops/control.sh "$target" "$expected"
"${compose[@]}" up -d discovery
discovery_was_running=false
# Exact same image in the standby, after new live slot has passed checks.
other=a;test "$slot" = b || other=b
"${compose[@]}" --profile second-slot up -d "api-$other"
python3 - <<'PY'
from pathlib import Path
import hmac,hashlib,subprocess
p=Path('/etc/nginx/conf.d/svitlo-pilot-https.conf');s=p.read_text()
secret=Path('/etc/svitlo/stage-secrets/session-secret').read_text().strip()
proof=hmac.new(secret.encode(),b'edge-client-v1',hashlib.sha256).hexdigest()
if 'X-Svitlo-Proxy-Proof' not in s:
 s=s.replace('proxy_set_header Host localhost:18765;', 'proxy_set_header Host localhost:18765;\n  proxy_set_header X-Svitlo-Client-IP $remote_addr;\n  proxy_set_header X-Svitlo-Proxy-Proof "'+proof+'";')
 previous=p.read_text();p.write_text(s)
 try:subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True)
 except BaseException:p.write_text(previous);raise
PY
for i in $(seq 1 30);do
 if /usr/local/sbin/svitlo-stage-health;then break;fi
 sleep 2
done
/usr/local/sbin/svitlo-stage-health
printf 'ARC_RELEASE_COMPLETE\n'
