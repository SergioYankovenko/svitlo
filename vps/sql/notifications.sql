-- ARCH-MOD-01-12. Additive modern channels; legacy recipients remain compatible.
create role svitlo_notifications_owner nologin nosuperuser nobypassrls;
create schema svitlo_notifications authorization svitlo_notifications_owner;
grant usage on schema public,auth,svitlo_events,svitlo_admin to svitlo_notifications_owner;
grant execute on function auth.uid(),svitlo_admin.account_allowed(uuid) to svitlo_notifications_owner;
grant execute on function svitlo_events.publish(text,text,bigint,jsonb,timestamptz,integer) to svitlo_notifications_owner;
grant select on public.svitlo_profiles to svitlo_notifications_owner;
grant update(snapshot_revision) on public.svitlo_profiles to svitlo_notifications_owner;
create policy notification_planner_lock on public.svitlo_profiles for update to svitlo_notifications_owner using(true) with check(false);
create policy notification_planner_read on public.svitlo_profiles for select to svitlo_notifications_owner using(true);
create table svitlo_notifications.control(id boolean primary key default true check(id),enabled boolean not null default false);
insert into svitlo_notifications.control values(true,false);
create table svitlo_notifications.installations(
 id uuid primary key,owner uuid not null references auth.users(id) on delete cascade,channel text not null check(channel in ('fcm','webpush')),
 token_hash text not null check(token_hash~'^[a-f0-9]{64}$'),cipher text not null check(length(cipher)<16000),credential_hash text not null,
 request_id uuid not null,request_hash text not null,registered_at timestamptz not null default clock_timestamp(),
 permission text not null check(permission in ('granted','denied')),quiet jsonb not null,revision bigint not null default 1,revoked_at timestamptz,
 unique(channel,token_hash)
);
create index notification_owner on svitlo_notifications.installations(owner) where revoked_at is null;
create table svitlo_notifications.plans(profile_id uuid primary key references public.svitlo_profiles(id) on delete cascade,
 plan_key text not null,preference_key text not null,revision bigint not null default 1,next_at timestamptz not null default clock_timestamp());
create table svitlo_notifications.intents(id uuid primary key default gen_random_uuid(),profile_id uuid not null references public.svitlo_profiles(id) on delete cascade,
 owner uuid not null references auth.users(id) on delete cascade,plan_key text not null,preference_key text not null,
 kind text not null check(kind in ('reminder','restoration','change','publication')),target_at timestamptz not null,due_at timestamptz not null,expires_at timestamptz not null,
 canceled boolean not null default false,unique(profile_id,kind,target_at,plan_key,preference_key));
create index notification_intents_cleanup on svitlo_notifications.intents(expires_at);
create table svitlo_notifications.deliveries(id uuid primary key default gen_random_uuid(),intent_id uuid not null references svitlo_notifications.intents(id) on delete cascade,
 installation_id uuid not null references svitlo_notifications.installations(id) on delete cascade,state text not null default 'ready' check(state in ('ready','running','accepted','canceled','dead')),
 attempts integer not null default 0,next_at timestamptz not null,lease_until timestamptz,proof uuid,received_at timestamptz,displayed_at timestamptz,error_code text,
 unique(intent_id,installation_id));
create index notification_due on svitlo_notifications.deliveries(next_at) where state in ('ready','running');

create function svitlo_notifications.profile_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin update svitlo_notifications.plans set next_at=clock_timestamp() where profile_id=new.id;return null;end $$;
create trigger notification_plan_dirty after update of snapshot,preferences,address on public.svitlo_profiles for each row execute function svitlo_notifications.profile_changed();

create function svitlo_notifications.remove_legacy(endpoint text) returns void language sql security definer set search_path='' as $$ delete from public.svitlo_subscriptions where owner=auth.uid() and subscription->>'endpoint'=endpoint $$;
create function svitlo_notifications.status() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',(select enabled from svitlo_notifications.control where id),'installations',coalesce((select jsonb_agg(jsonb_build_object('id',id,'channel',channel,'permission',permission,'revision',revision,'revoked',revoked_at is not null)) from svitlo_notifications.installations where owner=auth.uid()),'[]'::jsonb))
$$;
create function svitlo_notifications.register(installation_id uuid,request uuid,delivery_channel text,token_fingerprint text,encrypted_token text,new_proof text,old_proof text,payload_hash text,permission_state text,quiet_hours jsonb,legacy_endpoint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare subject uuid:=auth.uid();prior svitlo_notifications.installations;begin
 if subject is null or installation_id is null or request is null or not svitlo_admin.account_allowed(subject) then raise exception 'owner required';end if;
 if not (select enabled from svitlo_notifications.control where id) then return '{"error":"notifications_disabled"}';end if;
 perform pg_advisory_xact_lock(hashtextextended('notification-owner:'||subject::text,0));
 select * into prior from svitlo_notifications.installations where id=installation_id for update;
 if found then
  if prior.owner<>subject then return '{"error":"installation_owner_conflict"}';end if;
  if prior.request_id=request and prior.request_hash=payload_hash and prior.credential_hash=new_proof and prior.registered_at>clock_timestamp()-interval '5 minutes' then return jsonb_build_object('ok',true,'revision',prior.revision);end if;
  if prior.credential_hash<>old_proof then return '{"error":"installation_proof_required"}';end if;
 elsif (select count(*) from svitlo_notifications.installations where owner=subject and revoked_at is null)>=10 then return '{"error":"installation_limit"}';end if;
 if exists(select from svitlo_notifications.installations where channel=delivery_channel and token_hash=token_fingerprint and id<>installation_id) then return '{"error":"token_already_bound"}';end if;
 if permission_state not in ('granted','denied') or delivery_channel not in ('fcm','webpush') or new_proof!~'^[a-f0-9]{64}$' or payload_hash!~'^[a-f0-9]{64}$' or quiet_hours is null or jsonb_typeof(quiet_hours)<>'object' then raise exception 'invalid installation';end if;
 insert into svitlo_notifications.installations(id,owner,channel,token_hash,cipher,credential_hash,request_id,request_hash,permission,quiet)
 values(installation_id,subject,delivery_channel,token_fingerprint,encrypted_token,new_proof,request,payload_hash,permission_state,quiet_hours)
 on conflict(id) do update set channel=excluded.channel,token_hash=excluded.token_hash,cipher=excluded.cipher,credential_hash=excluded.credential_hash,request_id=excluded.request_id,request_hash=excluded.request_hash,registered_at=clock_timestamp(),permission=excluded.permission,quiet=excluded.quiet,revoked_at=null,revision=svitlo_notifications.installations.revision+1;
 update svitlo_notifications.plans set next_at=clock_timestamp() where profile_id in(select id from public.svitlo_profiles where owner=subject);
 if delivery_channel='webpush' and legacy_endpoint is not null then perform svitlo_notifications.remove_legacy(legacy_endpoint);end if;
 return jsonb_build_object('ok',true,'revision',coalesce(prior.revision,0)+1);
end $$;
create function svitlo_notifications.installation_action(installation_id uuid,credential text,action text,intent uuid,receipt text) returns jsonb language plpgsql security definer set search_path='' as $$
declare i svitlo_notifications.installations;begin
 select * into i from svitlo_notifications.installations where id=installation_id and owner=auth.uid() and credential_hash=credential for update;
 if not found then return '{"ok":false}';end if;
 if action='revoke' then update svitlo_notifications.installations set revoked_at=clock_timestamp(),permission='denied',revision=revision+1 where id=i.id;
 elsif action='receipt' and receipt in ('received','displayed') then
  update svitlo_notifications.deliveries set received_at=coalesce(received_at,clock_timestamp()),displayed_at=case when receipt='displayed' then coalesce(displayed_at,clock_timestamp()) else displayed_at end where installation_id=i.id and intent_id=intent and state='accepted';
 else raise exception 'invalid installation action';end if;
 if action='receipt' and receipt='received' then
  return coalesce((select jsonb_build_object('ok',true,'profile',jsonb_build_object('snapshot',p.snapshot,'address',p.address,'preferences',p.preferences),'intent',jsonb_build_object('intentId',t.id,'profileId',p.id,'planKey',t.plan_key,'preferenceKey',t.preference_key,'kind',t.kind,'targetAt',t.target_at,'expiresAt',t.expires_at,'quiet',i.quiet))
  from svitlo_notifications.deliveries d join svitlo_notifications.intents t on t.id=d.intent_id join public.svitlo_profiles p on p.id=t.profile_id
  where d.installation_id=i.id and d.intent_id=intent and d.state='accepted' and not t.canceled and t.expires_at>clock_timestamp() and i.revoked_at is null and i.permission='granted' and svitlo_admin.account_allowed(p.owner)), '{"ok":true,"displayAllowed":false}'::jsonb);
 end if;return '{"ok":true}';
end $$;
create function svitlo_notifications.due_profiles() returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'owner',p.owner,'snapshot',p.snapshot,'address',p.address,'preferences',p.preferences,'revision',p.snapshot_revision,'previousKey',n.plan_key)), '[]'::jsonb)
 from (select p.* from public.svitlo_profiles p left join svitlo_notifications.plans n on n.profile_id=p.id
 where (select enabled from svitlo_notifications.control where id) and coalesce(n.next_at,'-infinity')<=clock_timestamp()
 and exists(select from svitlo_notifications.installations i where i.owner=p.owner and i.revoked_at is null and i.permission='granted')
 order by coalesce(n.next_at,'-infinity'),p.id limit 5) p left join svitlo_notifications.plans n on n.profile_id=p.id
$$;
create function svitlo_notifications.apply_plan(profile uuid,expected_revision bigint,key text,prefs text,desired jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare p public.svitlo_profiles;n svitlo_notifications.plans;item jsonb;intent uuid;begin
 select * into p from public.svitlo_profiles where id=profile for share;
 if not found or p.snapshot_revision<>expected_revision or not svitlo_admin.account_allowed(p.owner) then return false;end if;
 perform pg_advisory_xact_lock(hashtextextended('notification-plan:'||profile::text,0));
 if key!~'^[a-f0-9]{64}$' or prefs!~'^[a-f0-9]{64}$' or jsonb_typeof(desired)<>'array' or jsonb_array_length(desired)>4 then raise exception 'invalid plan';end if;
 select * into n from svitlo_notifications.plans where profile_id=profile;
 update svitlo_notifications.intents set canceled=true where profile_id=profile and (plan_key<>key or preference_key<>prefs);
 insert into svitlo_notifications.plans(profile_id,plan_key,preference_key,next_at) values(profile,key,prefs,clock_timestamp()+interval '1 minute')
 on conflict(profile_id) do update set plan_key=excluded.plan_key,preference_key=excluded.preference_key,revision=svitlo_notifications.plans.revision+1,next_at=excluded.next_at;
 for item in select * from jsonb_array_elements(desired) loop
  if (item->>'expiresAt')::timestamptz<=clock_timestamp() or (item->>'expiresAt')::timestamptz>clock_timestamp()+interval '2 days' then continue;end if;
  -- First observation establishes baseline; never greet a new install with a change alert.
  if item->>'kind' in ('publication','change') and (n.profile_id is null or n.plan_key=key) then continue;end if;
  intent:=null;
  insert into svitlo_notifications.intents(profile_id,owner,plan_key,preference_key,kind,target_at,due_at,expires_at)
  values(profile,p.owner,key,prefs,item->>'kind',(item->>'targetAt')::timestamptz,(item->>'dueAt')::timestamptz,(item->>'expiresAt')::timestamptz)
  on conflict(profile_id,kind,target_at,plan_key,preference_key) do nothing returning id into intent;
  if intent is not null then perform svitlo_events.publish('notification.intent.v1',intent::text,1,jsonb_build_object('intentId',intent),(item->>'expiresAt')::timestamptz,1);end if;
 end loop;return true;
end $$;
create function svitlo_notifications.fanout(intent uuid) returns integer language plpgsql security definer set search_path='' as $$
declare n integer;begin
 insert into svitlo_notifications.deliveries(intent_id,installation_id,next_at)
 select t.id,i.id,t.due_at from svitlo_notifications.intents t join svitlo_notifications.installations i on i.owner=t.owner
 where t.id=intent and not t.canceled and t.expires_at>clock_timestamp() and i.revoked_at is null and i.permission='granted'
 on conflict(intent_id,installation_id) do nothing;get diagnostics n=row_count;return n;
end $$;
create function svitlo_notifications.entitlements_changed(account uuid) returns integer language plpgsql security definer set search_path='' as $$
declare n integer;begin
 update svitlo_notifications.plans set next_at=clock_timestamp() where profile_id in(select id from public.svitlo_profiles where owner=account);get diagnostics n=row_count;return n;
end $$;
create function svitlo_notifications.claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 update svitlo_notifications.deliveries d set state='canceled',proof=null,lease_until=null where d.id in(select x.id from svitlo_notifications.deliveries x join svitlo_notifications.intents t on t.id=x.intent_id where x.state in ('ready','running') and (t.canceled or t.expires_at<=clock_timestamp() or x.attempts>=5 and x.lease_until<=clock_timestamp()) limit 100);
 with due as(select d.id from svitlo_notifications.deliveries d join svitlo_notifications.intents t on t.id=d.intent_id join svitlo_notifications.installations i on i.id=d.installation_id
 where (select enabled from svitlo_notifications.control where id) and d.next_at<=clock_timestamp() and d.attempts<5 and (d.state='ready' or d.state='running' and d.lease_until<=clock_timestamp()) and not t.canceled and t.expires_at>clock_timestamp() and i.revoked_at is null and i.permission='granted' order by d.next_at,d.id limit 5 for update of d skip locked),claimed as(
 update svitlo_notifications.deliveries d set state='running',proof=gen_random_uuid(),lease_until=clock_timestamp()+interval '55 seconds',attempts=attempts+1 from due where d.id=due.id returning d.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'proof',d.proof,'installationId',i.id,'installationRevision',i.revision,'channel',i.channel,'cipher',i.cipher,'quiet',i.quiet,'intentId',t.id,'profileId',t.profile_id,'kind',t.kind,'planKey',t.plan_key,'preferenceKey',t.preference_key,'targetAt',t.target_at,'expiresAt',t.expires_at)), '[]'::jsonb) into result from claimed d join svitlo_notifications.intents t on t.id=d.intent_id join svitlo_notifications.installations i on i.id=d.installation_id;return result;
end $$;
create function svitlo_notifications.before_send(delivery uuid,token uuid,installation_revision bigint) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('snapshot',p.snapshot,'address',p.address,'preferences',p.preferences) from svitlo_notifications.deliveries d join svitlo_notifications.intents t on t.id=d.intent_id join svitlo_notifications.installations i on i.id=d.installation_id join public.svitlo_profiles p on p.id=t.profile_id
 where d.id=delivery and d.proof=token and d.state='running' and d.lease_until>clock_timestamp() and t.expires_at>clock_timestamp() and not t.canceled and i.revision=installation_revision and i.revoked_at is null and i.permission='granted' and svitlo_admin.account_allowed(p.owner) and (select enabled from svitlo_notifications.control where id)
$$;
create function svitlo_notifications.finish(delivery uuid,token uuid,outcome text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if outcome not in ('accepted','canceled','retry','invalid_token') then raise exception 'invalid notification outcome';end if;
 if outcome='invalid_token' then update svitlo_notifications.installations set revoked_at=clock_timestamp(),revision=revision+1 where id in(select installation_id from svitlo_notifications.deliveries where id=delivery and proof=token and state='running' and lease_until>clock_timestamp());end if;
 update svitlo_notifications.deliveries set state=case when outcome='retry' and attempts<5 then 'ready' when outcome='invalid_token' or outcome='retry' then 'dead' else outcome end,next_at=clock_timestamp()+make_interval(secs=>least(300,5*(2^attempts)::integer)),proof=null,lease_until=null,error_code=case when outcome in ('retry','invalid_token') then outcome end where id=delivery and proof=token and state='running' and lease_until>clock_timestamp();return found;
end $$;
create function svitlo_notifications.cleanup() returns integer language plpgsql security definer set search_path='' as $$
declare n integer;begin delete from svitlo_notifications.intents where id in(select id from svitlo_notifications.intents where expires_at<clock_timestamp()-interval '7 days' limit 500);get diagnostics n=row_count;return n;end $$;
do $$ declare r record;begin
 for r in select tablename from pg_tables where schemaname='svitlo_notifications' loop execute format('alter table svitlo_notifications.%I owner to svitlo_notifications_owner',r.tablename);end loop;
 for r in select p.oid::regprocedure f,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='svitlo_notifications' loop
  execute format('alter function %s owner to svitlo_notifications_owner',r.f);execute format('revoke all on function %s from public',r.f);
  if r.proname in ('status','register','installation_action') then execute format('grant execute on function %s to svitlo_stage_api',r.f);else execute format('grant execute on function %s to svitlo_stage_worker',r.f);end if;
 end loop;
end $$;
grant usage on schema svitlo_notifications to svitlo_stage_api,svitlo_stage_worker;

-- Execute the existing subscription-trigger path with its existing API role.
-- This narrow delegate has no owner argument; auth.uid() remains the caller's
-- authenticated owner. Notification owner receives no broad profile writes.
alter function svitlo_notifications.remove_legacy(text) owner to svitlo_stage_api;
revoke all on function svitlo_notifications.remove_legacy(text) from public,svitlo_stage_worker;
grant execute on function svitlo_notifications.remove_legacy(text) to svitlo_notifications_owner;
