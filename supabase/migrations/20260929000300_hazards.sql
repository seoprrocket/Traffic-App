-- Ticket Radar — more hazard types, each with its own lifetime. Safe to run more than once.

alter table public.reports drop constraint if exists reports_type_check;
alter table public.reports add constraint reports_type_check check (type in (
  'Speed trap / police', 'Officer location', 'Immigration enforcement (ICE)', 'Checkpoint',
  'Accident', 'Emergency vehicle', 'Pothole', 'Debris', 'Flooding', 'Icy road', 'Road hazard',
  'New camera', 'Ticket hotspot', 'Other'));

-- How long each kind of report stays on the map (keep in step with www/js/reports.js)
create or replace function public.report_ttl(p_type text) returns interval
language sql immutable as $$
  select case p_type
    when 'Speed trap / police' then interval '90 minutes'
    when 'Officer location' then interval '90 minutes'
    when 'Immigration enforcement (ICE)' then interval '3 hours'
    when 'Checkpoint' then interval '4 hours'
    when 'Accident' then interval '90 minutes'
    when 'Emergency vehicle' then interval '30 minutes'
    when 'Pothole' then interval '3 days'
    when 'Debris' then interval '2 hours'
    when 'Flooding' then interval '6 hours'
    when 'Icy road' then interval '6 hours'
    when 'New camera' then interval '30 days'
    when 'Ticket hotspot' then interval '30 days'
    else interval '3 hours' end
$$;

create or replace function public.reports_set_expiry() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.type is distinct from old.type then
    new.expires_at := coalesce(new.created_at, now()) + public.report_ttl(new.type);
  end if;
  return new;
end $$;
drop trigger if exists reports_set_expiry on public.reports;
create trigger reports_set_expiry before insert or update of type on public.reports
  for each row execute function public.reports_set_expiry();

-- "Still there" keeps a report alive at least 30 more minutes, without ever shortening it
create or replace function public.apply_vote() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.reports;
begin
  select * into r from public.reports where id = new.report_id;
  if r.user_id = new.user_id then
    raise exception 'You can''t vote on your own report.' using errcode = 'P0001';
  end if;
  update public.reports set
    confirms = (select count(*) from public.report_votes where report_id = new.report_id and vote = 1),
    denies   = (select count(*) from public.report_votes where report_id = new.report_id and vote = -1),
    expires_at = case when new.vote = 1 then greatest(expires_at, now() + interval '30 minutes') else expires_at end
  where id = new.report_id;
  update public.reports set status = 'hidden', moderation_reason = 'Drivers reported it gone'
  where id = new.report_id and denies >= 3 and denies > confirms and status in ('pending','live');
  return new;
end $$;
