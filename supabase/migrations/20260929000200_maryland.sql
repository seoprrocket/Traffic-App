-- Invictus Traffic Radar — Maryland coverage. Safe to run more than once.

-- Cameras from Maryland open data (Montgomery County sites, Prince George's County school zones)
alter table public.cameras drop constraint if exists cameras_source_check;
alter table public.cameras add constraint cameras_source_check
  check (source in ('user', 'dc_open_data', 'md_open_data', 'agent'));

-- Montgomery County now comes from its open data (exact coordinates), so stop reading its web page
update public.camera_sources
   set enabled = false, last_result = 'Replaced by Montgomery County open data'
 where jurisdiction = 'Montgomery County, MD';

-- More Maryland camera pages for the camera-sync agent to read (needs the AI agents turned on)
insert into public.camera_sources (jurisdiction, url) values
  ('Baltimore City, MD',      'https://transportation.baltimorecity.gov/atvesprogram'),
  ('Anne Arundel County, MD', 'https://www.aacounty.org/node/13042'),
  ('Howard County, MD',       'https://howardcountymd.gov/police/speed-camera-program'),
  ('Calvert County, MD',      'https://calvertcountymd.gov/2066/Speed-Cameras')
on conflict (url) do nothing;
