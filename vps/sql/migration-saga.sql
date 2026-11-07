-- Additive ARC-06 cancellation proof. A source fence is never released on an
-- ambiguous target commit. First durably make this nonce incapable of writes.
alter table svitlo_migration.transfers add column aborted_at timestamptz;
alter function svitlo_migration.commit(uuid,text,jsonb) rename to commit_before_saga;
revoke all on function svitlo_migration.commit_before_saga(uuid,text,jsonb) from svitlo_stage_api,public;
create function svitlo_migration.abort_transfer(nonce_id uuid,fingerprint text) returns boolean language plpgsql security definer set search_path='' as $$
declare t svitlo_migration.transfers;begin
 if auth.uid() is null then return false;end if;
 perform pg_advisory_xact_lock(hashtextextended('migration-target:'||auth.uid()::text,0));
 select * into t from svitlo_migration.transfers where nonce=nonce_id and digest=fingerprint and target_subject=auth.uid() for update;
 if not found or t.receipt is not null then return false;end if;
 update svitlo_migration.transfers set aborted_at=coalesce(aborted_at,clock_timestamp()) where nonce=nonce_id;return true;
end $$;
create function svitlo_migration.commit(nonce_id uuid,fingerprint text,source_fence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t svitlo_migration.transfers;begin
 if auth.uid() is null then return '{"error":"transfer_not_found"}';end if;
 perform pg_advisory_xact_lock(hashtextextended('migration-target:'||auth.uid()::text,0));
 select * into t from svitlo_migration.transfers where nonce=nonce_id and digest=fingerprint and target_subject=auth.uid() for update;
 if not found then return '{"error":"transfer_not_found"}';end if;
 if t.aborted_at is not null then return '{"error":"transfer_aborted"}';end if;
 return svitlo_migration.commit_before_saga(nonce_id,fingerprint,source_fence);
end $$;
alter function svitlo_migration.abort_transfer(uuid,text) owner to svitlo_migration_owner;
alter function svitlo_migration.commit(uuid,text,jsonb) owner to svitlo_migration_owner;
revoke all on function svitlo_migration.abort_transfer(uuid,text),svitlo_migration.commit(uuid,text,jsonb) from public;
grant execute on function svitlo_migration.abort_transfer(uuid,text),svitlo_migration.commit(uuid,text,jsonb) to svitlo_stage_api;

create or replace function svitlo_migration.receipt(nonce_id uuid,fingerprint text) returns jsonb language sql stable security definer set search_path='' as $$ select case when aborted_at is not null then '{"aborted":true}'::jsonb else receipt end from svitlo_migration.transfers where nonce=nonce_id and target_subject=auth.uid() and digest=fingerprint $$;
