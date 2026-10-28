-- Keep invalidation local to the changed profile/subscription/generation.
-- Claiming a 16-item page must not revalidate the entire pending queue.
create function public.svitlo_delivery_profile_changed() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.owner is not distinct from old.owner and new.preferences is not distinct from old.preferences
  and new.push_enabled is not distinct from old.push_enabled then return null; end if;
 update public.svitlo_deliveries d set cancelled=true
 where d.profile_id=new.id and not d.sent and not d.cancelled
  and not public.svitlo_delivery_valid(d,(extract(epoch from clock_timestamp())*1000)::bigint);
 return null;
end $$;
create trigger svitlo_delivery_profile_after after update of owner,preferences,push_enabled
on public.svitlo_profiles for each row execute function public.svitlo_delivery_profile_changed();

create function public.svitlo_delivery_generation_changed() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.generation is not distinct from old.generation then return null; end if;
 update public.svitlo_deliveries d set cancelled=true
 where d.profile_id=new.profile_id and not d.sent and not d.cancelled
  and d.generation is not null and d.generation is distinct from new.generation;
 return null;
end $$;
create trigger svitlo_delivery_generation_after after update of generation
on public.svitlo_reminder_tasks for each row execute function public.svitlo_delivery_generation_changed();

create function public.svitlo_delivery_subscription_changed() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.owner is not distinct from old.owner and new.profile_id is not distinct from old.profile_id then return null; end if;
 update public.svitlo_deliveries d set cancelled=true
 where d.subscription_id=new.id and not d.sent and not d.cancelled
  and not public.svitlo_delivery_valid(d,(extract(epoch from clock_timestamp())*1000)::bigint);
 return null;
end $$;
create trigger svitlo_delivery_subscription_after after update of owner,profile_id
on public.svitlo_subscriptions for each row execute function public.svitlo_delivery_subscription_changed();

-- Eliminate legacy invalid entries once. Future invalidation is scoped above;
-- expiry is checked on every claim and pruned by bounded maintenance below.
update public.svitlo_deliveries d set cancelled=true
where not d.sent and not d.cancelled
 and not public.svitlo_delivery_valid(d,(extract(epoch from clock_timestamp())*1000)::bigint);

create index svitlo_delivery_claimable on public.svitlo_deliveries(lease_until,id)
 where not sent and not cancelled and attempts<5;
create index svitlo_delivery_expiry on public.svitlo_deliveries(expires_at,id)
 where not sent and not cancelled;

create or replace function public.svitlo_delivery_batch(now_ms bigint,batch_size integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 item public.svitlo_deliveries;
 subscription jsonb;
 result jsonb:='[]'::jsonb;
 wanted integer:=greatest(1,least(coalesce(batch_size,16),16));
 claimed integer:=0;
 examined integer:=0;
 page_count integer;
begin
 -- A bounded repair budget handles unexpected legacy/stale prefixes while
 -- making durable progress. More than 4096 corrupt entries require another
 -- tick; they cannot permanently hide valid rows behind the same prefix.
 while claimed<wanted and examined<4096 loop
  page_count:=0;
  for item in
   select q.* from public.svitlo_deliveries q
   where not q.sent and not q.cancelled and q.attempts<5
    and q.expires_at>now_ms and q.lease_until<now_ms
   order by q.id
   limit least(wanted-claimed,4096-examined)
   for update skip locked
  loop
   examined:=examined+1;
   page_count:=page_count+1;
   if not public.svitlo_delivery_valid(item,now_ms) then
    update public.svitlo_deliveries set cancelled=true where id=item.id;
    continue;
   end if;
   update public.svitlo_deliveries d
    set lease_until=now_ms+55000,lease_token=gen_random_uuid(),attempts=d.attempts+1
    where d.id=item.id returning d.* into item;
   select s.subscription into subscription from public.svitlo_subscriptions s where s.id=item.subscription_id;
   result:=result||jsonb_build_array(to_jsonb(item)||jsonb_build_object('subscription',subscription));
   claimed:=claimed+1;
  end loop;
  exit when page_count=0;
 end loop;
 return result;
end $$;

create function public.svitlo_delivery_prune(now_ms bigint,batch_size integer default 1000) returns integer
language sql security invoker set search_path='' as $$
 with removed as (
  update public.svitlo_deliveries d set cancelled=true where d.id in (
   select q.id from public.svitlo_deliveries q
   where not q.sent and not q.cancelled and q.expires_at<=now_ms
   order by q.expires_at,q.id limit greatest(1,least(coalesce(batch_size,1000),5000))
   for update skip locked
  ) returning d.id
 ) select count(*)::integer from removed;
$$;

revoke all on function public.svitlo_delivery_profile_changed(),public.svitlo_delivery_generation_changed(),
 public.svitlo_delivery_subscription_changed(),public.svitlo_delivery_batch(bigint,integer),public.svitlo_delivery_prune(bigint,integer)
 from public,anon,authenticated;
grant execute on function public.svitlo_delivery_profile_changed(),public.svitlo_delivery_generation_changed(),
 public.svitlo_delivery_subscription_changed(),public.svitlo_delivery_batch(bigint,integer),public.svitlo_delivery_prune(bigint,integer)
 to service_role;
