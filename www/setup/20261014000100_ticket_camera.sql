-- Invictus Traffic Radar — remember which camera a ticket came from ("Got a ticket here"). Safe to run more than once.
alter table public.tickets add column if not exists camera_id text;
