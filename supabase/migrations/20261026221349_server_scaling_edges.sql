-- Zero means legacy unscheduled; a new subscription/feed must still become due now.
create or replace function public.svitlo_profile_work_changed() returns trigger language plpgsql set search_path='' as $$
declare t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 new.push_enabled:=public.svitlo_has_push(new);
 if new.push_enabled and (tg_op='INSERT' or not old.push_enabled) then
  new.next_check:=case when new.next_check=0 then t else least(new.next_check,t) end;
 end if;
 return new;
end $$;
create or replace function public.svitlo_feed_work_changed() returns trigger language plpgsql set search_path='' as $$
declare t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if new.key='feed' and (tg_op='INSERT' or new.value->'plans' is distinct from old.value->'plans' or new.value->'emergencies' is distinct from old.value->'emergencies') then
  update public.svitlo_profiles set next_check=case when next_check=0 then t else least(next_check,t) end where push_enabled;
  update public.svitlo_reminder_tasks q set due_at=0,generation=gen_random_uuid(),token=null,lease_until=0
   from public.svitlo_profiles p where p.id=q.profile_id and p.push_enabled;
 end if;
 return null;
end $$;
