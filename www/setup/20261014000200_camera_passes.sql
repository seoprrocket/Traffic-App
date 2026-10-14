-- Invictus Traffic Radar — "My roads": every camera you drive past is logged automatically,
-- with your fastest speed through its zone. Safe to run more than once.
create table if not exists public.camera_passes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  camera_id    text not null,
  name         text not null,
  kind         text,
  speed_limit  int,
  jurisdiction text,
  lat          double precision,
  lng          double precision,
  mph          int,
  at           timestamptz not null default now()
);
create index if not exists camera_passes_user_idx on public.camera_passes (user_id, at desc);
alter table public.camera_passes enable row level security;
drop policy if exists "own rows" on public.camera_passes;
create policy "own rows" on public.camera_passes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
