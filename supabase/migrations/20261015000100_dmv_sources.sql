-- Invictus Traffic Radar — camera coverage for all of Maryland, Washington DC and Virginia.
-- Exact-location feeds (DC, Montgomery, Prince George's, Arlington) and OpenStreetMap are pulled by the
-- camera-sync agent; these are the county / city web pages the page-reading agent checks for the rest.
-- Safe to run more than once.
insert into public.camera_sources (jurisdiction, url) values
  ('Fairfax County, VA',        'https://www.fairfaxcounty.gov/topics/node/414'),
  ('Arlington County, VA',      'https://www.arlingtonva.us/Government/Departments/Police-Department/Automated-Enforcement'),
  ('Alexandria City, VA',       'https://alexandriava.gov/go/3785'),
  ('Fairfax City, VA',          'https://www.fairfaxva.gov/Services/Public-Safety/Police/Photo-Enforcement')
on conflict (url) do nothing;
