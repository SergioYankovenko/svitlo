-- PWA-LIVE-62: expose the clock trust already enforced by phone_signal.
-- Additive DTO only; existing availability/expiry/ACL/history rules are unchanged.
do $$
declare definition text;updated text;begin
 definition:=pg_get_functiondef('svitlo_sensors.phone_signal(uuid,integer)'::regprocedure);
 updated:=replace(definition,'''freshnessSeconds'',900,','''clockQuality'',case when coalesce(s.trusted_sample,false) then ''synchronized'' else ''unsynchronized'' end,''freshnessSeconds'',900,');
 if updated=definition then raise exception 'phone_signal clock marker missing';end if;
 execute updated;
end $$;
