-- PWA-LIVE-01. Additive private-pilot opt-in; immutable older releases remain disabled.
alter table svitlo_vps.release_state add column pilot_push_enabled boolean not null default false;
update svitlo_vps.release_state set pilot_push_enabled=true where id;
create table svitlo_vps.sensor_notice_preferences(
 member_id uuid primary key references svitlo_sensors.memberships on delete cascade,
 enabled boolean not null default false,changed_at timestamptz not null default clock_timestamp()
);
create table svitlo_vps.sensor_notices(
 id uuid primary key default gen_random_uuid(),member_id uuid not null references svitlo_sensors.memberships on delete cascade,
 profile_id uuid not null references public.svitlo_profiles on delete cascade,
 subscription_id text not null references public.svitlo_subscriptions on delete cascade,
 binding_id uuid not null references svitlo_sensors.bindings on delete cascade,
 kind text not null check(kind in ('on','off','lost')),event_key text not null,
 created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 sent boolean not null default false,claim uuid,lease_until timestamptz,attempts integer not null default 0,
 next_try timestamptz not null default clock_timestamp(),unique(member_id,subscription_id,event_key)
);
create index sensor_notice_due on svitlo_vps.sensor_notices(next_try,created_at) where not sent;
create index sensor_notice_expiry on svitlo_vps.sensor_notices(expires_at);
create index sensor_notice_binding on svitlo_vps.sensor_notices(binding_id);
create index sensor_notice_profile on svitlo_vps.sensor_notices(profile_id);
create index sensor_notice_subscription on svitlo_vps.sensor_notices(subscription_id);
alter table svitlo_vps.sensor_notice_preferences enable row level security;
alter table svitlo_vps.sensor_notices enable row level security;
revoke all on svitlo_vps.sensor_notice_preferences,svitlo_vps.sensor_notices from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker;

-- The only API entry checks the live reader membership and linked owner profile.
create function svitlo_vps.sensor_notice_settings(sensor uuid,epoch integer,value boolean default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member uuid; result boolean; begin
 if auth.uid() is null then raise insufficient_privilege;end if;
 select m.member_id into member from svitlo_sensors.memberships m
 join svitlo_sensors.bindings b using(binding_id) join svitlo_sensors.devices d using(sensor_id)
 join svitlo_sensors.reader_links l using(member_id) join public.svitlo_profiles p on p.id=l.profile_id
 where m.subject=auth.uid() and p.owner=auth.uid() and m.revoked_at is null and b.ended_at is null
 and b.sensor_id=$1 and b.epoch=$2 and d.current_epoch=b.epoch and d.status='bound';
 if member is null then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
 if value is not null then
  insert into svitlo_vps.sensor_notice_preferences(member_id,enabled) values(member,value)
  on conflict(member_id) do update set enabled=excluded.enabled,changed_at=clock_timestamp()
  where sensor_notice_preferences.enabled is distinct from excluded.enabled;
  if not value then delete from svitlo_vps.sensor_notices where member_id=member and not sent;end if;
 end if;
 select enabled into result from svitlo_vps.sensor_notice_preferences where member_id=member;
 return jsonb_build_object('http',200,'enabled',coalesce(result,false));
end $$;

-- Fixed-data trigger, no API execution and no network I/O in a telemetry transaction.
create function svitlo_vps.sensor_notice_enqueue(binding uuid,kind text,key text,occurred timestamptz) returns void
language sql security definer set search_path='' as $$
 insert into svitlo_vps.sensor_notices(member_id,profile_id,subscription_id,binding_id,kind,event_key,expires_at)
 select m.member_id,p.id,s.id,b.binding_id,$2,$3,clock_timestamp()+interval '5 minutes'
 from svitlo_sensors.memberships m join svitlo_sensors.bindings b using(binding_id)
 join svitlo_sensors.devices d using(sensor_id) join svitlo_sensors.reader_links l using(member_id)
 join public.svitlo_profiles p on p.id=l.profile_id and p.owner=m.subject
 join svitlo_vps.sensor_notice_preferences n on n.member_id=m.member_id and n.enabled and n.changed_at<=$4
 join public.svitlo_subscriptions s on s.owner=m.subject
 where b.binding_id=$1 and b.ended_at is null and m.revoked_at is null and d.status='bound' and d.current_epoch=b.epoch
 and exists(select 1 from svitlo_vps.release_state where id and pilot_push_enabled)
 on conflict(member_id,subscription_id,event_key) do nothing;
$$;
create function svitlo_vps.sensor_notice_capture() returns trigger language plpgsql security definer set search_path='' as $$
declare ttl interval; stamp timestamptz:=clock_timestamp(); begin
 select case when exists(select 1 from svitlo_sensors.phone_devices f where f.sensor_id=b.sensor_id)
 then interval '15 minutes' else make_interval(secs=>(select fresh_seconds from svitlo_sensors.ingest_policy where id)) end
 into ttl from svitlo_sensors.bindings b where b.binding_id=new.binding_id;
 if old.stream_id=new.stream_id and old.trusted_sample and new.trusted_sample
 and old.last_confirmed_at>=stamp-ttl and old.last_received_at>=stamp-ttl
 and new.last_confirmed_at>=stamp-ttl and new.last_received_at>=stamp-ttl
 and new.last_confirmed_at>=old.last_confirmed_at and new.last_confirmed_state is distinct from old.last_confirmed_state
 and new.last_confirmed_state in ('on','off') and not exists(select 1 from svitlo_sensors.ingest_credentials c where c.binding_id=new.binding_id and c.revoked_at is not null) then
  perform svitlo_vps.sensor_notice_enqueue(new.binding_id,new.last_confirmed_state,
   new.stream_id::text||':'||new.max_sequence::text||':'||new.last_confirmed_state,new.last_confirmed_at);
 end if;
 return new;
end $$;
create trigger sensor_notice_transition after update on svitlo_sensors.ingest_latest for each row execute function svitlo_vps.sensor_notice_capture();

-- Offline is a connection notice, never an inferred power-off notice. No initial stale replay.
create function svitlo_vps.sensor_notice_sweep() returns void language plpgsql security definer set search_path='' as $$
declare r record;begin
 for r in select s.* from svitlo_sensors.ingest_latest s join svitlo_sensors.bindings b using(binding_id)
 where b.ended_at is null and s.last_confirmed_state in ('on','off') and s.trusted_sample
 and s.last_received_at<clock_timestamp()-case when exists(select 1 from svitlo_sensors.phone_devices f where f.sensor_id=b.sensor_id) then interval '15 minutes' else make_interval(secs=>(select fresh_seconds from svitlo_sensors.ingest_policy where id)) end
 and s.last_received_at>clock_timestamp()-interval '1 day'
 and exists(select 1 from svitlo_sensors.ingest_credentials c where c.binding_id=s.binding_id and c.revoked_at is null)
 order by s.last_received_at desc limit 1000 loop
  perform svitlo_vps.sensor_notice_enqueue(r.binding_id,'lost',r.stream_id::text||':lost:'||r.last_received_at::text,r.last_received_at);
 end loop;
 delete from svitlo_vps.sensor_notices where expires_at<clock_timestamp()-interval '1 day';
end $$;
create function svitlo_vps.sensor_notice_valid(notice uuid,token uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from svitlo_vps.sensor_notices n
 join svitlo_vps.sensor_notice_preferences pref on pref.member_id=n.member_id and pref.enabled and pref.changed_at<=n.created_at
 join svitlo_sensors.memberships m on m.member_id=n.member_id and m.binding_id=n.binding_id and m.revoked_at is null
 join svitlo_sensors.bindings b on b.binding_id=n.binding_id and b.ended_at is null
 join svitlo_sensors.devices d on d.sensor_id=b.sensor_id and d.current_epoch=b.epoch and d.status='bound'
 join svitlo_sensors.reader_links l on l.member_id=m.member_id and l.profile_id=n.profile_id
 join public.svitlo_profiles p on p.id=n.profile_id and p.owner=m.subject
 join public.svitlo_subscriptions s on s.id=n.subscription_id and s.owner=m.subject
 where n.id=$1 and n.claim=$2 and not n.sent and n.expires_at>clock_timestamp() and n.lease_until>clock_timestamp()
 and exists(select 1 from svitlo_vps.release_state where id and pilot_push_enabled));
$$;
create function svitlo_vps.sensor_notice_claim() returns table(id uuid,claim uuid,kind text,profile_id uuid,subscription_id text,subscription jsonb,expires_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare n svitlo_vps.sensor_notices;begin
 for n in update svitlo_vps.sensor_notices set claim=gen_random_uuid(),lease_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1
 where sensor_notices.id in(select x.id from svitlo_vps.sensor_notices x where not x.sent and x.attempts<5 and x.next_try<=clock_timestamp()
 and x.expires_at>clock_timestamp() and coalesce(x.lease_until,'-infinity'::timestamptz)<clock_timestamp() order by x.created_at limit 1 for update skip locked)
 returning * loop
  if svitlo_vps.sensor_notice_valid(n.id,n.claim) then return query select n.id,n.claim,n.kind,n.profile_id,n.subscription_id,s.subscription,n.expires_at from public.svitlo_subscriptions s where s.id=n.subscription_id;
  else delete from svitlo_vps.sensor_notices where sensor_notices.id=n.id;end if;
 end loop;
end $$;
create function svitlo_vps.sensor_notice_finish(notice uuid,token uuid,outcome text) returns void language sql security definer set search_path='' as $$
 update svitlo_vps.sensor_notices set sent=($3='sent'),next_try=clock_timestamp()+interval '30 seconds',lease_until=null,claim=null
 where id=$1 and claim=$2 and lease_until>clock_timestamp() and $3 in ('sent','retry');
$$;
revoke all on function svitlo_vps.sensor_notice_settings(uuid,integer,boolean),svitlo_vps.sensor_notice_enqueue(uuid,text,text,timestamptz),svitlo_vps.sensor_notice_capture(),svitlo_vps.sensor_notice_sweep(),svitlo_vps.sensor_notice_claim(),svitlo_vps.sensor_notice_valid(uuid,uuid),svitlo_vps.sensor_notice_finish(uuid,uuid,text) from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker;
grant execute on function svitlo_vps.sensor_notice_settings(uuid,integer,boolean) to svitlo_stage_api;
grant execute on function svitlo_vps.sensor_notice_sweep(),svitlo_vps.sensor_notice_claim(),svitlo_vps.sensor_notice_valid(uuid,uuid),svitlo_vps.sensor_notice_finish(uuid,uuid,text) to svitlo_stage_worker;
