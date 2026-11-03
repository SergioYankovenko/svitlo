-- Compatibility names are NOLOGIN placeholders, not Supabase users or a Supabase stack.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
revoke all on schema auth from public;
create table auth.users(id uuid primary key,created_at timestamptz not null default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('svitlo.owner_id',true),'')::uuid $$;
revoke create on schema public from public;
