-- Invictus Traffic Radar — database schema
-- Run once on a new Supabase project (SQL editor, or `supabase db push`).
-- Everything a user creates is private to them by default (row level security).
-- The community only ever sees the anonymized views at the bottom of this file.

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------
-- Profiles (one per account, created automatically on sign-up)
-- ---------------------------------------------------------------
create table public.profiles (
  id                uuid primary key references auth.users on delete cascade,
  display_name      text check (char_length(display_name) <= 60),
  home_label        text check (char_length(home_label) <= 120),
  work_label        text check (char_length(work_label) <= 120),
  avoid_risk        text not null default 'warn' check (avoid_risk in ('warn','alt')),
  settings          jsonb not null default '{}'::jsonb,
  email_coach       boolean not null default true,
  accepted_terms_at timestamptz,
  is_admin          boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------
-- Tickets the user received
-- ---------------------------------------------------------------
create table public.tickets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  street      text not null check (char_length(street) <= 160),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  ticket_date date,
  ticket_time time,
  due_date    date,          -- pay-or-contest deadline printed on the notice
  type        text not null default 'Other',
  fine        numeric(8,2) check (fine >= 0),
  speed       int check (speed between 0 and 200),
  speed_limit int check (speed_limit between 0 and 100),
  notes       text check (char_length(notes) <= 1000),
  alert_type  text not null default 'voice' check (alert_type in ('visual','sound','voice')),
  shared      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index tickets_user_idx on public.tickets (user_id);
create trigger tickets_touch before update on public.tickets for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------
-- Cameras: official (owner_id null) or a user's private pins
-- ---------------------------------------------------------------
create table public.cameras (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid default auth.uid() references auth.users on delete cascade,   -- null = official
  source       text not null default 'user' check (source in ('user','dc_open_data','agent')),
  source_ref   text,
  jurisdiction text,
  name         text not null check (char_length(name) <= 200),
  lat          double precision not null,
  lng          double precision not null,
  kind         text not null default 'Speed',
  speed_limit  int,
  heading      int check (heading between 0 and 359),   -- direction of travel the camera enforces
  verified     boolean not null default false,
  status       text not null default 'active' check (status in ('active','retired')),
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (source, source_ref)
);
create index cameras_owner_idx on public.cameras (owner_id);
create index cameras_geo_idx on public.cameras (lat, lng);
create trigger cameras_touch before update on public.cameras for each row execute function public.touch_updated_at();

-- Pages the camera-sync agent reads for jurisdictions without structured data
create table public.camera_sources (
  id           uuid primary key default gen_random_uuid(),
  jurisdiction text not null,
  url          text not null unique,
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  last_result  text
);
insert into public.camera_sources (jurisdiction, url) values
  ('Montgomery County, MD', 'https://www.montgomerycountymd.gov/pol/howdoI/speed-camera-locations.html'),
  ('Gaithersburg, MD',      'https://www.gaithersburgmd.gov/services/police-services/safe-speed-program');

-- ---------------------------------------------------------------
-- Community reports
-- ---------------------------------------------------------------
create table public.reports (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  type              text not null check (type in (
                      'Speed trap / police','Officer location','Immigration enforcement (ICE)','Checkpoint',
                      'New camera','Ticket hotspot','Icy road','Road hazard','Other')),
  lat               double precision not null,
  lng               double precision not null,
  place             text check (char_length(place) <= 200),
  note              text check (char_length(note) <= 280),
  clean_note        text,                        -- note after moderation; the only version others see
  status            text not null default 'pending' check (status in ('pending','live','hidden','merged')),
  merged_into       uuid references public.reports (id) on delete set null,
  moderation_reason text,
  confirms          int not null default 0,
  denies            int not null default 0,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '6 hours',
  updated_at        timestamptz not null default now()
);
create index reports_live_idx on public.reports (status, expires_at);
create index reports_user_idx on public.reports (user_id);
create trigger reports_touch before update on public.reports for each row execute function public.touch_updated_at();

-- Spam limit: 10 reports per person per hour
create or replace function public.reports_rate_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.reports
      where user_id = new.user_id and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Report limit reached. You can post 10 reports per hour.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger reports_rate_limit before insert on public.reports for each row execute function public.reports_rate_limit();

-- Edits by the author send the report back through moderation
create or replace function public.reports_reset_on_edit() returns trigger
language plpgsql as $$
begin
  if new.note is distinct from old.note or new.type is distinct from old.type
     or new.lat is distinct from old.lat or new.lng is distinct from old.lng then
    new.status := 'pending'; new.clean_note := null; new.moderation_reason := null;
  end if;
  return new;
end $$;
create trigger reports_reset_on_edit before update on public.reports for each row execute function public.reports_reset_on_edit();

-- Ask the moderator agent to review new and edited reports.
-- If the agent isn't configured yet, publish right away (note stays hidden until reviewed).
create or replace function public.request_moderation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  if new.status <> 'pending' then return new; end if;
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then return new; end if;
  perform net.http_post(
    url     := v_url || '/functions/v1/moderate-report',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', v_secret),
    body    := jsonb_build_object('report_id', new.id));
  return new;
end $$;
create trigger reports_moderate after insert or update of note, type, lat, lng on public.reports
  for each row execute function public.request_moderation();

-- "Still there?" votes
create table public.report_votes (
  report_id  uuid not null references public.reports on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  vote       smallint not null check (vote in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);

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
    -- each "still there" keeps the report alive 30 more minutes, never more than 6 hours ahead
    expires_at = case when new.vote = 1
                      then least(greatest(expires_at, now() + interval '30 minutes'), now() + interval '6 hours')
                      else expires_at end
  where id = new.report_id;
  update public.reports set status = 'hidden', moderation_reason = 'Drivers reported it gone'
  where id = new.report_id and denies >= 3 and denies > confirms and status in ('pending','live');
  return new;
end $$;
create trigger report_votes_apply after insert or update on public.report_votes
  for each row execute function public.apply_vote();

-- ---------------------------------------------------------------
-- Routes, commutes, trips, drive events, alert log
-- ---------------------------------------------------------------
create table public.routes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null check (char_length(name) <= 80),
  start_pt   jsonb not null,   -- {lat,lng,label}
  end_pt     jsonb not null,
  hit_count  int,
  meters     double precision,
  secs       double precision,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
create index routes_user_idx on public.routes (user_id);

create table public.commutes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  route_id   uuid not null references public.routes on delete cascade,
  days       smallint[] not null default '{1,2,3,4,5}',
  depart     time not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);
create index commutes_user_idx on public.commutes (user_id);

create table public.trips (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  start_lat  double precision not null, start_lng double precision not null,
  end_lat    double precision not null, end_lng double precision not null,
  started_at timestamptz not null, ended_at timestamptz not null,
  meters     double precision,
  max_mph    int,
  alerts     int not null default 0
);
create index trips_user_idx on public.trips (user_id, started_at desc);

create table public.drive_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  kind        text not null check (kind in ('enter','exit')),
  zone        text not null,
  zone_type   text not null,
  speed       int,
  speed_limit int,
  at          timestamptz not null default now()
);
create index drive_events_user_idx on public.drive_events (user_id, at desc);

create table public.alert_log (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind    text not null,
  title   text not null,
  detail  text,
  at      timestamptz not null default now()
);
create index alert_log_user_idx on public.alert_log (user_id, at desc);

-- ---------------------------------------------------------------
-- Agent output
-- ---------------------------------------------------------------
create table public.coach_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  week_start date not null,
  headline   text not null,
  body       jsonb not null,   -- {summary, wins[], focus[], stats{}}
  created_at timestamptz not null default now(),
  unique (user_id, week_start)
);

create table public.commute_predictions (
  user_id    uuid primary key references auth.users on delete cascade,
  patterns   jsonb not null,   -- [{name, days[], depart, start{}, end{}, trips, confidence, risk_note}]
  updated_at timestamptz not null default now()
);

create table public.disputes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  ticket_id  uuid references public.tickets on delete set null,
  analysis   jsonb not null,
  letter     text,
  created_at timestamptz not null default now()
);
create index disputes_user_idx on public.disputes (user_id, created_at desc);

-- Per-person daily caps on AI calls, so one account can't run up the bill
create table public.ai_usage (
  user_id uuid not null references auth.users on delete cascade,
  fn      text not null,
  day     date not null default current_date,
  calls   int not null default 0,
  primary key (user_id, fn, day)
);

create or replace function public.bump_ai_usage(p_user uuid, p_fn text, p_limit int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.ai_usage (user_id, fn, day, calls) values (p_user, p_fn, current_date, 1)
  on conflict (user_id, fn, day) do update set calls = public.ai_usage.calls + 1
  returning calls into n;
  return n <= p_limit;
end $$;
revoke all on function public.bump_ai_usage(uuid, text, int) from public, anon, authenticated;

-- ---------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.tickets             enable row level security;
alter table public.cameras             enable row level security;
alter table public.camera_sources      enable row level security;
alter table public.reports             enable row level security;
alter table public.report_votes        enable row level security;
alter table public.routes              enable row level security;
alter table public.commutes            enable row level security;
alter table public.trips               enable row level security;
alter table public.drive_events        enable row level security;
alter table public.alert_log           enable row level security;
alter table public.coach_reports       enable row level security;
alter table public.commute_predictions enable row level security;
alter table public.disputes            enable row level security;
alter table public.ai_usage            enable row level security;

create policy "own profile read"   on public.profiles for select to authenticated using (id = auth.uid());
create policy "own profile update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated;
grant update (display_name, home_label, work_label, avoid_risk, settings, email_coach, accepted_terms_at) on public.profiles to authenticated;

-- "owner can do everything with their own rows" for the personal tables
do $$
declare t text;
begin
  foreach t in array array['tickets','routes','commutes','trips','drive_events','alert_log'] loop
    execute format('create policy "own rows" on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

create policy "own coach reports read"  on public.coach_reports       for select to authenticated using (user_id = auth.uid());
create policy "own predictions read"    on public.commute_predictions for select to authenticated using (user_id = auth.uid());
create policy "own disputes read"       on public.disputes            for select to authenticated using (user_id = auth.uid());
create policy "own disputes delete"     on public.disputes            for delete to authenticated using (user_id = auth.uid());
create policy "own usage read"          on public.ai_usage            for select to authenticated using (user_id = auth.uid());

-- Cameras: everyone sees official cameras; you see and manage your own pins
create policy "official cameras read" on public.cameras for select to anon, authenticated
  using (owner_id is null and status = 'active');
create policy "own cameras" on public.cameras for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid() and source = 'user');

-- Reports: you manage your own; everyone else reads them through live_reports (no author id)
create policy "own reports" on public.reports for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke update on public.reports from authenticated;
grant update (type, lat, lng, place, note) on public.reports to authenticated;

create policy "own votes" on public.report_votes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- camera_sources: no policies → only the service role (agents) can read/write

-- ---------------------------------------------------------------
-- Public, anonymized views (these intentionally bypass row security
-- and expose only the columns listed)
-- ---------------------------------------------------------------
create or replace view public.live_reports as
select r.id, r.type, r.lat, r.lng, r.place,
       case when r.status = 'live' then r.clean_note end as note,
       r.status, r.confirms, r.denies, r.created_at, r.expires_at,
       (r.user_id = auth.uid()) as mine,
       (select v.vote from public.report_votes v where v.report_id = r.id and v.user_id = auth.uid()) as my_vote
from public.reports r
where r.status in ('pending','live') and r.expires_at > now();

create or replace view public.shared_hotspots as
select t.id,
       round(t.lat::numeric, 3)::double precision as lat,     -- about 100 m
       round(t.lng::numeric, 3)::double precision as lng,
       t.street, t.type,
       to_char(t.ticket_date, 'YYYY-MM') as month,
       case when t.fine is null then 'unknown'
            when t.fine < 100 then 'under $100'
            when t.fine < 200 then '$100–199'
            when t.fine < 300 then '$200–299'
            else '$300+' end as fine_range,
       (t.user_id = auth.uid()) as mine
from public.tickets t
where t.shared;

grant select on public.live_reports, public.shared_hotspots to anon, authenticated;
