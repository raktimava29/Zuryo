create extension if not exists pgcrypto;
create extension if not exists btree_gist;

do $$ begin create type user_role as enum ('CUSTOMER', 'TRAINER', 'OPS');
exception when duplicate_object then null; end $$;
do $$ begin create type booking_mode as enum ('INSTANT', 'SCHEDULED');
exception when duplicate_object then null; end $$;
do $$ begin create type booking_status as enum ('PENDING', 'CONFIRMED', 'CANCELLED', 'IN_PROGRESS', 'COMPLETED', 'NO_TRAINER');
exception when duplicate_object then null; end $$;
do $$ begin create type session_record_status as enum ('DRAFT', 'FINAL');
exception when duplicate_object then null; end $$;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  role user_role not null,
  is_demo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists customer_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  age smallint check (age between 16 and 100),
  weight_kg numeric(5,2) check (weight_kg > 0 and weight_kg < 500),
  fitness_goals text[] not null default '{}',
  fitness_level text not null default 'BEGINNER' check (fitness_level in ('BEGINNER', 'INTERMEDIATE', 'ADVANCED')),
  workout_preferences text[] not null default '{}',
  service_zone text not null default 'ZONE-A',
  updated_at timestamptz not null default now()
);

create table if not exists trainer_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  service_zones text[] not null default '{ZONE-A}',
  specialties text[] not null default '{}',
  is_active boolean not null default true,
  average_rating numeric(2,1) check (average_rating between 0 and 5),
  created_at timestamptz not null default now()
);

create table if not exists trainer_availability (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references trainer_profiles(user_id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  constraint availability_positive_window check (ends_at > starts_at)
);
create index if not exists idx_trainer_availability_window on trainer_availability (trainer_id, starts_at, ends_at) where is_available = true;

create table if not exists packages (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customer_profiles(user_id) on delete cascade,
  package_name text not null,
  sessions_purchased integer not null check (sessions_purchased > 0),
  sessions_used integer not null default 0 check (sessions_used >= 0),
  price_paid numeric(10,2) not null check (price_paid >= 0),
  created_at timestamptz not null default now(),
  constraint package_usage_not_over_purchased check (sessions_used <= sessions_purchased)
);
create index if not exists idx_packages_customer on packages(customer_id);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customer_profiles(user_id),
  trainer_id uuid references trainer_profiles(user_id),
  mode booking_mode not null,
  status booking_status not null default 'PENDING',
  service_zone text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  session_price numeric(10,2) not null check (session_price >= 0),
  commission_rate numeric(5,4) not null default 0.10 check (commission_rate between 0 and 1),
  commission_amount numeric(10,2) not null check (commission_amount >= 0),
  total_amount numeric(10,2) not null check (total_amount >= 0),
  package_id uuid references packages(id),
  payment_status text not null default 'PENDING' check (payment_status in ('PENDING', 'SIMULATED_PAID', 'REFUNDED', 'NOT_REQUIRED')),
  session_started_at timestamptz,
  session_completed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_positive_window check (ends_at > starts_at),
  constraint booking_duration_60m check (ends_at = starts_at + interval '60 minutes'),
  constraint booking_total_matches_breakdown check (total_amount = session_price + commission_amount)
);
create unique index if not exists idx_booking_idempotency_key on bookings(customer_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_bookings_customer_time on bookings(customer_id, starts_at desc);
create index if not exists idx_bookings_trainer_time on bookings(trainer_id, starts_at, ends_at);
create index if not exists idx_bookings_status_time on bookings(status, starts_at);
do $$ begin
  alter table bookings add constraint bookings_trainer_no_overlap
  exclude using gist (
    trainer_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (trainer_id is not null and status in ('CONFIRMED', 'IN_PROGRESS'));
exception when duplicate_object then null;
end $$;

create table if not exists session_records (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id) on delete cascade,
  exercises jsonb not null default '[]'::jsonb,
  duration_minutes integer check (duration_minutes between 0 and 60),
  trainer_notes text,
  customer_feedback text,
  suggested_next_workout text,
  status session_record_status not null default 'DRAFT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references users(id) on delete cascade,
  booking_id uuid references bookings(id) on delete cascade,
  event_type text not null,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_recipient on notifications(recipient_id, created_at desc);

insert into users (email, display_name, role)
values ('customer.demo@zuryo.local', 'Demo Customer', 'CUSTOMER'),
       ('trainer.demo@zuryo.local', 'Demo Trainer', 'TRAINER'),
       ('ops.demo@zuryo.local', 'Demo Operations', 'OPS')
on conflict (email) do nothing;

insert into customer_profiles (user_id, age, weight_kg, fitness_goals, fitness_level, workout_preferences, service_zone)
select id, 27, 72.5, array['STRENGTH', 'GENERAL_FITNESS'], 'BEGINNER', array['BODYWEIGHT', 'LOW_IMPACT'], 'ZONE-A'
from users where email = 'customer.demo@zuryo.local'
on conflict (user_id) do nothing;

insert into trainer_profiles (user_id, service_zones, specialties, is_active, average_rating)
select id, array['ZONE-A', 'ZONE-B'], array['STRENGTH', 'GENERAL_FITNESS'], true, 4.8
from users where email = 'trainer.demo@zuryo.local'
on conflict (user_id) do nothing;

-- Demo trainers work daily from 06:00 to 22:00 Asia/Kolkata.
-- Availability rows represent working windows, not fixed booking slots.
-- API accepts any minute-aligned 60-minute booking fully inside a window.
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
where not exists (
  select 1 from trainer_availability a
  where a.trainer_id = tp.user_id
    and a.starts_at = ((work_day::date + time '06:00') at time zone 'Asia/Kolkata')
    and a.ends_at = ((work_day::date + time '22:00') at time zone 'Asia/Kolkata')
);

insert into packages (customer_id, package_name, sessions_purchased, sessions_used, price_paid)
select cp.user_id, 'Starter 5', 5, 0, 1995.00
from customer_profiles cp
where cp.user_id = (select id from users where email = 'customer.demo@zuryo.local')
and not exists (select 1 from packages p where p.customer_id = cp.user_id and p.package_name = 'Starter 5');
