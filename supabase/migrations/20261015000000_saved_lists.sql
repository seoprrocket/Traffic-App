-- Invictus Traffic Radar — saved places: Home / Work on the profile, favorite lists, and lists shared with friends
-- by a join code. Safe to run more than once.

-- Home and work with coordinates (the labels already existed)
alter table public.profiles add column if not exists home_pt jsonb;
alter table public.profiles add column if not exists work_pt jsonb;
grant update (home_pt, work_pt) on public.profiles to authenticated;

create table if not exists public.lists (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  icon        text not null default '⭐' check (char_length(icon) <= 8),
  share_code  text unique check (share_code ~ '^[A-Z0-9]{6,12}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists public.list_members (
  list_id     uuid not null references public.lists on delete cascade,
  user_id     uuid not null references auth.users on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (list_id, user_id)
);
create table if not exists public.list_places (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references public.lists on delete cascade,
  added_by    uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  note        text check (char_length(note) <= 300),
  kind        text check (char_length(kind) <= 40),
  created_at  timestamptz not null default now()
);
create index if not exists list_places_list_idx on public.list_places (list_id, created_at desc);
create index if not exists list_members_user_idx on public.list_members (user_id);

-- "Can I see this list?" — owner or member. security definer so the policies below don't recurse.
create or replace function public.can_see_list(l uuid) returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.lists where id = l and owner_id = auth.uid())
      or exists (select 1 from public.list_members where list_id = l and user_id = auth.uid());
$$;
grant execute on function public.can_see_list(uuid) to authenticated;

-- Join a shared list with its code → the list id
create or replace function public.join_list(code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare l uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id into l from public.lists where share_code = upper(trim(code));
  if l is null then raise exception 'That code does not match a shared list'; end if;
  insert into public.list_members (list_id, user_id) values (l, auth.uid()) on conflict do nothing;
  return l;
end $$;
grant execute on function public.join_list(text) to authenticated;

alter table public.lists        enable row level security;
alter table public.list_members enable row level security;
alter table public.list_places  enable row level security;

drop policy if exists "lists read"   on public.lists;
drop policy if exists "lists insert" on public.lists;
drop policy if exists "lists update" on public.lists;
drop policy if exists "lists delete" on public.lists;
create policy "lists read"   on public.lists for select to authenticated using (public.can_see_list(id));
create policy "lists insert" on public.lists for insert to authenticated with check (owner_id = auth.uid());
create policy "lists update" on public.lists for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "lists delete" on public.lists for delete to authenticated using (owner_id = auth.uid());

drop policy if exists "members read"  on public.list_members;
drop policy if exists "members leave" on public.list_members;
create policy "members read"  on public.list_members for select to authenticated using (user_id = auth.uid() or public.can_see_list(list_id));
create policy "members leave" on public.list_members for delete to authenticated using (user_id = auth.uid() or exists (select 1 from public.lists where id = list_id and owner_id = auth.uid()));

drop policy if exists "places read"   on public.list_places;
drop policy if exists "places insert" on public.list_places;
drop policy if exists "places update" on public.list_places;
drop policy if exists "places delete" on public.list_places;
create policy "places read"   on public.list_places for select to authenticated using (public.can_see_list(list_id));
create policy "places insert" on public.list_places for insert to authenticated with check (added_by = auth.uid() and public.can_see_list(list_id));
create policy "places update" on public.list_places for update to authenticated using (added_by = auth.uid() or exists (select 1 from public.lists where id = list_id and owner_id = auth.uid()));
create policy "places delete" on public.list_places for delete to authenticated using (added_by = auth.uid() or exists (select 1 from public.lists where id = list_id and owner_id = auth.uid()));
