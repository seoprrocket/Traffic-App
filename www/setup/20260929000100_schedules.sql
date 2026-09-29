-- Invictus Traffic Radar — scheduled agents
-- Run AFTER you have (1) deployed the edge functions and (2) stored two secrets in Vault:
--   select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'project_url');
--   select vault.create_secret('PASTE-A-LONG-RANDOM-STRING',           'cron_secret');
-- The same cron_secret must be set as the CRON_SECRET edge-function secret.
-- Times are UTC (Eastern = UTC-4 in summer, UTC-5 in winter).

create extension if not exists pg_cron;

create or replace function public.call_agent(p_fn text, p_body jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    raise exception 'Store project_url and cron_secret in Vault first';
  end if;
  return net.http_post(
    url     := v_url || '/functions/v1/' || p_fn,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', v_secret),
    body    := p_body,
    timeout_milliseconds := 150000);
end $$;
revoke all on function public.call_agent(text, jsonb) from public, anon, authenticated;

-- Camera data: every day at 5:15 am Eastern
select cron.schedule('camera-sync-daily',     '15 9 * * *',  $$ select public.call_agent('camera-sync') $$);
-- Commute patterns: every night at 3:30 am Eastern
select cron.schedule('commute-predict-nightly','30 7 * * *', $$ select public.call_agent('commute-predict') $$);
-- Weekly coach email: Mondays at 7:45 am Eastern
select cron.schedule('weekly-coach-monday',   '45 11 * * 1', $$ select public.call_agent('weekly-coach') $$);

-- Safety net: if the moderator hasn't answered in 5 minutes, publish the report with its note hidden
select cron.schedule('publish-stuck-reports', '*/5 * * * *', $$
  update public.reports
     set status = 'live', clean_note = null, moderation_reason = 'Auto-published; note withheld'
   where status = 'pending' and created_at < now() - interval '5 minutes'
$$);

-- Housekeeping: drop drive history older than a year, AI usage counters older than 30 days
select cron.schedule('housekeeping-weekly', '0 8 * * 0', $$
  delete from public.drive_events where at < now() - interval '1 year';
  delete from public.alert_log    where at < now() - interval '1 year';
  delete from public.ai_usage     where day < current_date - 30;
$$);
