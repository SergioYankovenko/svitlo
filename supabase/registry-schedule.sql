-- Prepared only: run after separate deployment/scheduling approval.
-- Daily dispatcher checks nextCheckAt. A successful import is due every 14 elapsed days
-- (daily near expiry); failed imports retry with backoff. Avoid */14 day-of-month drift.
select cron.schedule('svitlo-registry-check','17 2 * * *',$$
 select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/svitlo-registry',
  headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',
    (select decrypted_secret from vault.decrypted_secrets where name='svitlo_cron_secret')),
  body := '{}'::jsonb, timeout_milliseconds := 120000
 );
$$);
