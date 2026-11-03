create function svitlo_vps.session_cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare removed integer; begin
 delete from svitlo_vps.sessions where token_hash in(select token_hash from svitlo_vps.sessions where expires_at<now() limit 1000);
 get diagnostics removed=row_count;
 delete from auth.users where id in(select u.id from auth.users u where u.created_at<now()-interval '30 days'
  and not exists(select 1 from svitlo_vps.sessions s where s.owner=u.id)
  and not exists(select 1 from public.svitlo_profiles p where p.owner=u.id) limit 1000);
 return jsonb_build_object('expiredSessions',removed);
end $$;
revoke all on function svitlo_vps.session_cleanup() from public;
grant execute on function svitlo_vps.session_cleanup() to svitlo_stage_worker;
