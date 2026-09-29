-- Invictus Traffic Radar — status check for the setup dashboard (www/setup.html)
-- Returns yes/no flags and counts only. It never returns secret values.
-- To hide it after setup:  revoke execute on function public.setup_status() from anon;

create extension if not exists pgcrypto with schema extensions;

create or replace function public.setup_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := jsonb_build_object('version', 1);
  v_cron text;
begin
  -- Vault secrets the database uses to call the agents (existence only, plus a short fingerprint to catch mismatches)
  select decrypted_secret into v_cron from vault.decrypted_secrets where name = 'cron_secret';
  r := r || jsonb_build_object(
    'vault_project_url', exists (select 1 from vault.decrypted_secrets where name = 'project_url'),
    'vault_cron_secret', v_cron is not null,
    'cron_hash', case when v_cron is null then null
                      else left(encode(extensions.digest(v_cron, 'sha256'), 'hex'), 8) end);

  -- Scheduled jobs and how their last run went
  begin
    r := r || jsonb_build_object('cron_jobs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', j.jobname,
        'last_status', (select d.status from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1),
        'last_run', (select d.start_time from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1)
      ) order by j.jobname), '[]'::jsonb) from cron.job j));
  exception when others then
    r := r || jsonb_build_object('cron_jobs', null);
  end;

  -- Has the Maryland update (20260929000200_maryland.sql) been run?
  r := r || jsonb_build_object('maryland', exists (
    select 1 from pg_constraint where conname = 'cameras_source_check'
      and pg_get_constraintdef(oid) like '%md_open_data%'));

  -- Has the hazards update (20260929000300_hazards.sql) been run?
  r := r || jsonb_build_object('hazards', exists (
    select 1 from pg_proc where proname = 'report_ttl' and pronamespace = 'public'::regnamespace));

  r := r || jsonb_build_object(
    'cameras', (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb)
                  from (select source, count(*) as n from public.cameras
                        where owner_id is null and status = 'active' group by source) x),
    'camera_sources', (select coalesce(jsonb_agg(jsonb_build_object(
                         'jurisdiction', jurisdiction, 'enabled', enabled,
                         'last_run_at', last_run_at, 'last_result', last_result) order by jurisdiction), '[]'::jsonb)
                       from public.camera_sources),
    'reports_waiting', (select count(*) from public.reports
                        where status = 'pending' and created_at < now() - interval '2 minutes'
                          and created_at > now() - interval '1 day'));
  return r;
end $$;

grant execute on function public.setup_status() to anon, authenticated;
