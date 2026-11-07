-- Verified purchase evidence and RTDN inbox. Neither client fields nor RTDN
-- notification types can grant rights; the worker queries Developer API.
do $$ begin if not exists(select from pg_roles where rolname='svitlo_billing_owner') then create role svitlo_billing_owner nologin nobypassrls;end if;end $$;
create schema svitlo_billing authorization svitlo_billing_owner;revoke all on schema svitlo_billing from public;
create table svitlo_billing.control(id boolean primary key default true check(id),mode text not null default 'disabled' check(mode in('disabled','license','live')),accepting boolean not null default false,worker_ready boolean not null default false,last_worker_at timestamptz);
insert into svitlo_billing.control(id) values(true);
create table svitlo_billing.purchases(
 id uuid primary key default gen_random_uuid(),account_id uuid not null references auth.users on delete cascade,
 token_hash text not null unique check(token_hash~'^[a-f0-9]{64}$'),token_cipher text not null check(length(token_cipher) between 40 and 12000),product_id text not null check(length(product_id) between 1 and 100),
 state text not null default 'unverified',valid_until timestamptz,verified_at timestamptz,verification_revision bigint not null default 0,request_revision bigint not null default 1,
 next_at timestamptz not null default clock_timestamp(),lease_token uuid,lease_until timestamptz,replaced_by uuid references svitlo_billing.purchases,
 created_at timestamptz not null default clock_timestamp()
);
create index billing_due on svitlo_billing.purchases(next_at,id) where replaced_by is null;
create table svitlo_billing.replaced_tokens(token_hash text primary key check(token_hash~'^[a-f0-9]{64}$'),replaced_by uuid not null references svitlo_billing.purchases on delete cascade);
create table svitlo_billing.inbox(message_id text primary key check(length(message_id) between 1 and 200),token_hash text check(token_hash is null or token_hash~'^[a-f0-9]{64}$'),kind text not null check(kind in('subscription','voided','test')),event_time timestamptz not null,received_at timestamptz not null default clock_timestamp());
create index billing_inbox_retention on svitlo_billing.inbox(received_at);
do $$ declare t text;begin foreach t in array array['control','purchases','replaced_tokens','inbox'] loop execute 'alter table svitlo_billing.'||t||' owner to svitlo_billing_owner';execute 'revoke all on svitlo_billing.'||t||' from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session,svitlo_stage_admin';end loop;end $$;
insert into svitlo_events.event_types(type,payload_keys) values('billing.acknowledge.v1',array['purchaseId']);
insert into svitlo_events.consumers(id,type) values('billing-acknowledge-v1','billing.acknowledge.v1');
grant usage on schema auth,svitlo_identity,svitlo_entitlements,svitlo_events to svitlo_billing_owner;
grant select on svitlo_identity.accounts to svitlo_billing_owner;
grant execute on function auth.uid(),svitlo_events.publish(text,text,bigint,jsonb,timestamptz,integer),svitlo_entitlements.apply_play(uuid,uuid,bigint,boolean,timestamptz,timestamptz,boolean) to svitlo_billing_owner;
create function svitlo_billing.ready() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('mode',mode,'accepting',accepting,'ready',coalesce(mode<>'disabled' and worker_ready and last_worker_at>clock_timestamp()-interval '5 minutes',false)) from svitlo_billing.control where id
$$;
create function svitlo_billing.worker_status(available boolean) returns jsonb language plpgsql security definer set search_path='' as $$begin
 update svitlo_billing.control set worker_ready=available,last_worker_at=clock_timestamp() where id;return svitlo_billing.ready();
end $$;
create function svitlo_billing.checkout_allowed() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select from svitlo_identity.accounts where id=auth.uid() and recoverable) and coalesce((svitlo_billing.ready()->>'ready')::boolean,false) and (select accepting from svitlo_billing.control where id)
$$;
create function svitlo_billing.register_purchase(proof_hash text,cipher text,product text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();purchase svitlo_billing.purchases;begin
 if actor is null then return '{"state":"session_required"}';end if;
 if not coalesce((svitlo_billing.ready()->>'ready')::boolean,false) or not (select accepting from svitlo_billing.control where id) then return '{"state":"not_configured"}';end if;
 if not exists(select from svitlo_identity.accounts where id=actor and recoverable) then return '{"state":"recoverable_account_required"}';end if;
 if proof_hash!~'^[a-f0-9]{64}$' or cipher is null or length(cipher) not between 40 and 12000 or product is null or length(product) not between 1 and 100 then raise exception 'invalid purchase reference';end if;
 perform pg_advisory_xact_lock(hashtextextended('play-token:'||proof_hash,0));
 if exists(select from svitlo_billing.replaced_tokens where token_hash=proof_hash) then return '{"state":"purchase_replaced"}';end if;
 select * into purchase from svitlo_billing.purchases where token_hash=proof_hash;
 if found then if purchase.account_id<>actor then return '{"state":"purchase_in_use"}';end if;return jsonb_build_object('state','pending_verification','purchaseId',purchase.id);end if;
 if (select count(*) from svitlo_billing.purchases where account_id=actor and state='unverified' and created_at>clock_timestamp()-interval '1 day')>=5 then return '{"state":"purchase_registration_limit"}';end if;
 insert into svitlo_billing.purchases(account_id,token_hash,token_cipher,product_id,next_at) values(actor,proof_hash,cipher,product,clock_timestamp()+interval '15 minutes') returning * into purchase;
 perform svitlo_events.publish('billing.reconcile.v1',purchase.id::text,purchase.request_revision,jsonb_build_object('purchaseId',purchase.id));
 return jsonb_build_object('state','pending_verification','purchaseId',purchase.id);
end $$;
create function svitlo_billing.claim_purchase(purchase_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p svitlo_billing.purchases;begin
 select * into p from svitlo_billing.purchases where id=purchase_id for update;
 if not found or p.lease_until>clock_timestamp() then return null;end if;
 update svitlo_billing.purchases set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '55 seconds' where id=p.id returning * into p;
 return jsonb_build_object('id',p.id,'accountId',p.account_id,'tokenHash',p.token_hash,'cipher',p.token_cipher,'productId',p.product_id,'proof',p.lease_token,'replaced',p.replaced_by is not null);
end $$;
create function svitlo_billing.release_purchase(purchase_id uuid,proof uuid) returns boolean language plpgsql security definer set search_path='' as $$begin
 update svitlo_billing.purchases set lease_token=null,lease_until=null where id=purchase_id and lease_token=proof;return found;
end $$;
create function svitlo_billing.apply_purchase(purchase_id uuid,proof uuid,provider_state text,expires timestamptz,is_active boolean,testing boolean,needs_ack boolean,linked_hash text) returns boolean language plpgsql security definer set search_path='' as $$
declare p svitlo_billing.purchases;old svitlo_billing.purchases;version bigint;active_right boolean;begin
 -- All involved purchase rows are locked before the account entitlement lock.
 perform 1 from svitlo_billing.purchases where id=purchase_id or token_hash=linked_hash order by id for update;
 select * into p from svitlo_billing.purchases where id=purchase_id and lease_token=proof and lease_until>clock_timestamp();if not found then return false;end if;
 if provider_state is null or provider_state not in('SUBSCRIPTION_STATE_PENDING','SUBSCRIPTION_STATE_ACTIVE','SUBSCRIPTION_STATE_PAUSED','SUBSCRIPTION_STATE_IN_GRACE_PERIOD','SUBSCRIPTION_STATE_ON_HOLD','SUBSCRIPTION_STATE_CANCELED','SUBSCRIPTION_STATE_EXPIRED','SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED') or expires is null or is_active is null or testing is null or needs_ack is null or linked_hash is not null and linked_hash!~'^[a-f0-9]{64}$' then raise exception 'invalid verified purchase';end if;
 if linked_hash=p.token_hash then raise exception 'purchase replacement cycle';end if;
 if linked_hash is not null and is_active and p.replaced_by is null then
  if exists(select from svitlo_billing.replaced_tokens where token_hash=linked_hash and replaced_by<>p.id) then raise exception 'purchase replacement conflict';end if;
  select * into old from svitlo_billing.purchases where token_hash=linked_hash;
  if found then
   if old.account_id<>p.account_id then raise exception 'linked purchase owner conflict';end if;
   update svitlo_billing.purchases set replaced_by=p.id,verification_revision=verification_revision+1 where id=old.id returning verification_revision into version;
   perform svitlo_entitlements.apply_play(old.id,old.account_id,version,false,coalesce(old.valid_until,clock_timestamp()),clock_timestamp()+interval '24 hours',testing);
  end if;
  insert into svitlo_billing.replaced_tokens values(linked_hash,p.id) on conflict(token_hash) do nothing;
 end if;
 active_right:=is_active and p.replaced_by is null;
 update svitlo_billing.purchases set state=provider_state,valid_until=expires,verified_at=clock_timestamp(),verification_revision=verification_revision+1,next_at=clock_timestamp()+interval '15 minutes',lease_token=null,lease_until=null where id=p.id returning verification_revision into version;
 perform svitlo_entitlements.apply_play(p.id,p.account_id,version,active_right,expires,clock_timestamp()+interval '24 hours',testing);
 if needs_ack and active_right then perform svitlo_events.publish('billing.acknowledge.v1',p.id::text,version,jsonb_build_object('purchaseId',p.id),clock_timestamp()+interval '1 day');end if;
 return true;
end $$;
create function svitlo_billing.accept_rtdn(message_key text,purchase_hash text,event_kind text,event_at timestamptz) returns boolean language plpgsql security definer set search_path='' as $$
declare inserted boolean;purchase svitlo_billing.purchases;begin
 if event_at is null or event_at>clock_timestamp()+interval '5 minutes' then raise exception 'invalid RTDN time';end if;
 insert into svitlo_billing.inbox(message_id,token_hash,kind,event_time) values(message_key,purchase_hash,event_kind,event_at) on conflict(message_id) do nothing;inserted:=found;
 if not inserted then
  if exists(select from svitlo_billing.inbox where message_id=message_key and (token_hash,kind,event_time) is distinct from (purchase_hash,event_kind,event_at)) then raise exception 'RTDN message conflict';end if;return true;
 end if;
 -- Never project notification state; re-read the provider even for old events.
 update svitlo_billing.purchases set request_revision=request_revision+1,next_at=clock_timestamp()+interval '15 minutes' where token_hash=purchase_hash returning * into purchase;
 if found then perform svitlo_events.publish('billing.reconcile.v1',purchase.id::text,purchase.request_revision,jsonb_build_object('purchaseId',purchase.id));end if;
 return true;
end $$;
create function svitlo_billing.schedule_due() returns integer language plpgsql security definer set search_path='' as $$
declare p svitlo_billing.purchases;n integer:=0;begin
 if not coalesce((svitlo_billing.ready()->>'ready')::boolean,false) then return 0;end if;
 for p in update svitlo_billing.purchases set request_revision=request_revision+1,next_at=clock_timestamp()+interval '15 minutes' where id in(select id from svitlo_billing.purchases where next_at<=clock_timestamp() and replaced_by is null order by next_at,id limit 20 for update skip locked) returning * loop
  perform svitlo_events.publish('billing.reconcile.v1',p.id::text,p.request_revision,jsonb_build_object('purchaseId',p.id));n:=n+1;
 end loop;
 delete from svitlo_billing.inbox where message_id in(select message_id from svitlo_billing.inbox where received_at<clock_timestamp()-interval '91 days' order by received_at limit 1000);return n;
end $$;
do $$ declare f text;begin foreach f in array array['ready()','worker_status(boolean)','checkout_allowed()','register_purchase(text,text,text)','claim_purchase(uuid)','release_purchase(uuid,uuid)','apply_purchase(uuid,uuid,text,timestamptz,boolean,boolean,boolean,text)','accept_rtdn(text,text,text,timestamptz)','schedule_due()'] loop execute 'alter function svitlo_billing.'||f||' owner to svitlo_billing_owner';execute 'revoke all on function svitlo_billing.'||f||' from public';end loop;end $$;
grant usage on schema svitlo_billing to svitlo_stage_api,svitlo_stage_worker;
grant execute on function svitlo_billing.ready(),svitlo_billing.checkout_allowed(),svitlo_billing.register_purchase(text,text,text),svitlo_billing.accept_rtdn(text,text,text,timestamptz) to svitlo_stage_api;
grant execute on function svitlo_billing.worker_status(boolean),svitlo_billing.ready(),svitlo_billing.claim_purchase(uuid),svitlo_billing.release_purchase(uuid,uuid),svitlo_billing.apply_purchase(uuid,uuid,text,timestamptz,boolean,boolean,boolean,text),svitlo_billing.schedule_due() to svitlo_stage_worker;
