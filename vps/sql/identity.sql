-- Recoverable accounts preserve the existing auth.users UUID. Provider subject
-- is the identity key; email, install ID and address equality are not proofs.
do $$ begin if not exists(select from pg_roles where rolname='svitlo_identity_owner') then create role svitlo_identity_owner nologin nobypassrls;end if;end $$;
create schema svitlo_identity authorization svitlo_identity_owner;revoke all on schema svitlo_identity from public;
create table svitlo_identity.accounts(id uuid primary key references auth.users on delete cascade,recoverable boolean not null default false,created_at timestamptz not null default now());
insert into svitlo_identity.accounts(id) select id from auth.users;
create table svitlo_identity.subjects(provider text not null check(provider='google'),issuer text not null check(issuer='https://accounts.google.com'),subject text not null check(length(subject) between 1 and 255),account_id uuid not null references svitlo_identity.accounts,created_at timestamptz not null default now(),primary key(provider,issuer,subject));
create index identity_subject_account on svitlo_identity.subjects(account_id);
create table svitlo_identity.challenges(nonce_hash text primary key check(nonce_hash~'^[a-f0-9]{64}$'),session_hash text not null,owner uuid not null references auth.users on delete cascade,mode text not null check(mode in('sign_in','link')),expires_at timestamptz not null,consumed_at timestamptz);
create index identity_challenge_expiry on svitlo_identity.challenges(expires_at);
create table svitlo_identity.switches(proof_hash text primary key check(proof_hash~'^[a-f0-9]{64}$'),session_hash text not null,from_account uuid not null references auth.users on delete cascade,to_account uuid not null references auth.users on delete cascade,expires_at timestamptz not null,consumed_at timestamptz);
create index identity_switch_expiry on svitlo_identity.switches(expires_at);
do $$ declare t text;begin foreach t in array array['accounts','subjects','challenges','switches'] loop execute 'alter table svitlo_identity.'||t||' owner to svitlo_identity_owner';execute 'revoke all on svitlo_identity.'||t||' from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session';end loop;end $$;
grant usage on schema auth,svitlo_vps,svitlo_sensors,svitlo_admin to svitlo_identity_owner;
grant select(id) on auth.users to svitlo_identity_owner;
grant select,insert,delete on svitlo_vps.sessions to svitlo_identity_owner;
grant update(expires_at) on svitlo_vps.sessions to svitlo_identity_owner;
grant select(owner) on public.svitlo_profiles to svitlo_identity_owner;
grant execute on function auth.uid(),svitlo_admin.account_allowed(uuid) to svitlo_identity_owner;
create policy identity_profile_count on public.svitlo_profiles for select to svitlo_identity_owner using(owner=auth.uid());
grant select(owner_subject,ended_at) on svitlo_sensors.bindings to svitlo_identity_owner;
create policy identity_binding_count on svitlo_sensors.bindings for select to svitlo_identity_owner using(owner_subject=auth.uid());
grant select(subject,valid_until,revoked_at) on svitlo_sensors.main_app_subscriptions to svitlo_identity_owner;
create policy identity_subscription_count on svitlo_sensors.main_app_subscriptions for select to svitlo_identity_owner using(subject=auth.uid());
create function svitlo_identity.new_account() returns trigger language plpgsql security definer set search_path='' as $$begin insert into svitlo_identity.accounts(id) values(new.id) on conflict do nothing;return new;end $$;
create trigger identity_account_created after insert on auth.users for each row execute function svitlo_identity.new_account();
create function svitlo_identity.status(proof text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('accountId',a.id,'recoverable',a.recoverable,'provider',case when a.recoverable then 'google' else null end) from svitlo_vps.sessions s join svitlo_identity.accounts a on a.id=s.owner where s.token_hash=proof and s.expires_at>clock_timestamp() and svitlo_admin.account_allowed(a.id)
$$;
create function svitlo_identity.challenge(proof text,nonce text,operation text) returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid;begin
 if nonce!~'^[a-f0-9]{64}$' or operation not in('sign_in','link') then raise exception 'invalid identity challenge';end if;
 select owner into actor from svitlo_vps.sessions where token_hash=proof and expires_at>clock_timestamp() for share;if not found or not svitlo_admin.account_allowed(actor) then return false;end if;
 perform pg_advisory_xact_lock(hashtextextended('identity-challenge:'||proof,0));
 if (select count(*) from svitlo_identity.challenges where session_hash=proof and expires_at>clock_timestamp())>=5 then return false;end if;
 insert into svitlo_identity.challenges values(nonce,proof,actor,operation,clock_timestamp()+interval '5 minutes',null);return true;
end $$;
create function svitlo_identity.challenge_valid(proof text,nonce text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select from svitlo_identity.challenges c join svitlo_vps.sessions s on s.token_hash=c.session_hash where c.nonce_hash=nonce and c.session_hash=proof and c.consumed_at is null and c.expires_at>clock_timestamp() and s.expires_at>clock_timestamp() and svitlo_admin.account_allowed(s.owner))
$$;
create function svitlo_identity.finish(proof text,nonce text,google_subject text,new_session text,review_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare old_session svitlo_vps.sessions;challenge svitlo_identity.challenges;target uuid;profiles integer;sensors integer;begin
 if google_subject is null or length(google_subject) not between 1 and 255 or new_session!~'^[a-f0-9]{64}$' or review_hash!~'^[a-f0-9]{64}$' then raise exception 'invalid identity result';end if;
 select * into old_session from svitlo_vps.sessions where token_hash=proof and expires_at>clock_timestamp() for update;
 if not found or not svitlo_admin.account_allowed(old_session.owner) then return '{"state":"session_required"}';end if;
 select * into challenge from svitlo_identity.challenges c where c.nonce_hash=nonce and c.session_hash=proof and c.owner=old_session.owner and c.consumed_at is null and c.expires_at>clock_timestamp() for update;
 if not found then return '{"state":"challenge_expired"}';end if;
 perform pg_advisory_xact_lock(hashtextextended('google-subject:'||google_subject,0));
 select account_id into target from svitlo_identity.subjects where provider='google' and issuer='https://accounts.google.com' and subject=google_subject;
 if not found then
  target:=old_session.owner;
  insert into svitlo_identity.subjects(provider,issuer,subject,account_id) values('google','https://accounts.google.com',google_subject,target);
  update svitlo_identity.accounts set recoverable=true where id=target;
 end if;
 update svitlo_identity.challenges set consumed_at=clock_timestamp() where nonce_hash=nonce;
 if not svitlo_admin.account_allowed(target) then return '{"state":"account_blocked"}';end if;
 if target<>old_session.owner then
  if challenge.mode='link' then return '{"state":"identity_in_use"}';end if;
  perform set_config('svitlo.owner_id',old_session.owner::text,true);
  select count(*) into profiles from public.svitlo_profiles where owner=old_session.owner;
  select count(*) into sensors from svitlo_sensors.bindings where owner_subject=old_session.owner and ended_at is null;
  if profiles>0 or sensors>0 or exists(select from svitlo_identity.accounts where id=old_session.owner and recoverable) or exists(select from svitlo_sensors.main_app_subscriptions where subject=old_session.owner and valid_until>clock_timestamp() and revoked_at is null) then
   insert into svitlo_identity.switches values(review_hash,proof,old_session.owner,target,clock_timestamp()+interval '5 minutes',null);
   return jsonb_build_object('state','confirmation_required','guestProfiles',profiles,'ownedSensors',sensors,'mergeSupported',false);
  end if;
 end if;
 insert into svitlo_vps.sessions(token_hash,owner,expires_at) values(new_session,target,clock_timestamp()+interval '30 days');
 delete from svitlo_vps.sessions where token_hash=proof;
 return jsonb_build_object('state','authenticated','accountId',target,'recoverable',true);
end $$;
create function svitlo_identity.confirm_switch(proof text,review_hash text,new_session text) returns jsonb language plpgsql security definer set search_path='' as $$
declare pending svitlo_identity.switches;actor uuid;begin
 if new_session!~'^[a-f0-9]{64}$' then raise exception 'invalid session proof';end if;
 select owner into actor from svitlo_vps.sessions where token_hash=proof and expires_at>clock_timestamp() for update;
 if not found or not svitlo_admin.account_allowed(actor) then return '{"state":"session_required"}';end if;
 select * into pending from svitlo_identity.switches where proof_hash=review_hash and session_hash=proof and from_account=actor and consumed_at is null and expires_at>clock_timestamp() for update;
 if not found then return '{"state":"confirmation_expired"}';end if;
 if not svitlo_admin.account_allowed(pending.to_account) then return '{"state":"account_blocked"}';end if;
 update svitlo_identity.switches set consumed_at=clock_timestamp() where proof_hash=review_hash;
 insert into svitlo_vps.sessions(token_hash,owner,expires_at) values(new_session,pending.to_account,clock_timestamp()+interval '30 days');delete from svitlo_vps.sessions where token_hash=proof;
 return jsonb_build_object('state','authenticated','accountId',pending.to_account,'recoverable',true);
end $$;
create function svitlo_identity.cleanup() returns void language plpgsql security definer set search_path='' as $$begin
 delete from svitlo_identity.challenges where nonce_hash in(select nonce_hash from svitlo_identity.challenges where expires_at<clock_timestamp() limit 1000);
 delete from svitlo_identity.switches where proof_hash in(select proof_hash from svitlo_identity.switches where expires_at<clock_timestamp() limit 1000);
end $$;
do $$ declare f text;begin foreach f in array array['new_account()','status(text)','challenge(text,text,text)','challenge_valid(text,text)','finish(text,text,text,text,text)','confirm_switch(text,text,text)','cleanup()'] loop execute 'alter function svitlo_identity.'||f||' owner to svitlo_identity_owner';execute 'revoke all on function svitlo_identity.'||f||' from public';end loop;end $$;
grant usage on schema svitlo_identity to svitlo_stage_session,svitlo_stage_worker;
grant execute on function svitlo_identity.status(text),svitlo_identity.challenge(text,text,text),svitlo_identity.challenge_valid(text,text),svitlo_identity.finish(text,text,text,text,text),svitlo_identity.confirm_switch(text,text,text) to svitlo_stage_session;
grant execute on function svitlo_identity.cleanup() to svitlo_stage_worker;
