-- Run once against existing Supabase database to enable arbitrary 15-minute starts.
-- Trainer availability rows are working windows; each booking still lasts exactly 60 minutes.
-- Demo window: daily 06:00-22:00 Asia/Kolkata, seeded for 30 days.
insert into trainer_availability (trainer_id, starts_at, ends_at, is_available)
select tp.user_id,
       (work_day::date + time '06:00') at time zone 'Asia/Kolkata',
       (work_day::date + time '22:00') at time zone 'Asia/Kolkata',
       true
from trainer_profiles tp
cross join generate_series(
  (now() at time zone 'Asia/Kolkata')::date,
  (now() at time zone 'Asia/Kolkata')::date + 30,
  interval '1 day'
) as work_day
where tp.is_active = true
  and not exists (
    select 1 from trainer_availability a
    where a.trainer_id = tp.user_id
      and a.starts_at = ((work_day::date + time '06:00') at time zone 'Asia/Kolkata')
      and a.ends_at = ((work_day::date + time '22:00') at time zone 'Asia/Kolkata')
  );

create index if not exists idx_trainer_availability_window
  on trainer_availability (trainer_id, starts_at, ends_at)
  where is_available = true;
