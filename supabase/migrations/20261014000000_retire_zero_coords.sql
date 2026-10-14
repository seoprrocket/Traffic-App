-- Invictus Traffic Radar — retire official cameras stored without a real position (0,0).
-- Montgomery County's open data leaves coordinates blank on many sites; an early camera-sync saved
-- those as latitude/longitude 0, which inflated the camera count. Safe to run more than once.
update public.cameras
   set status = 'retired'
 where owner_id is null
   and status = 'active'
   and (lat = 0 or lng = 0 or lat is null or lng is null);
