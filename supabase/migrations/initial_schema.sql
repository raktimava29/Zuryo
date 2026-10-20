create extension if not exists btree_gist;

create type public.app_role as enum ('CUSTOMER', 'TRAINER', 'ADMIN');

create type public.booking_status as enum (
  'PENDING_PAYMENT',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'PAYMENT_FAILED'
);

create type public.booking_mode as enum ('INSTANT', 'SCHEDULED');

create type public.slot_type as enum ('NORMAL', 'PEAK');

create type public.payment_status as enum (
  'PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) between 1 and 100),
  role public.app_role not null default 'CUSTOMER',
  created_at timestamptz not null default now()
);

create table public.service_zones (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  timezone text not null default 'Asia/Kolkata',
  center_lat double precision,
  center_lng double precision,
  radius_km numeric(6,2) not null default 5
    check (radius_km > 0)
);

create table public.trainer_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  service_zone_id uuid not null references public.service_zones(id),
  active boolean not null default true,
  location_lat double precision,
  location_lng double precision,
  created_at timestamptz not null default now()
);

create table public.trainer_availability (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles(user_id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_available boolean not null default true,
  check (ends_at > starts_at),
  unique (trainer_id, starts_at, ends_at)
);

create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  slot_type public.slot_type not null unique,
  base_price_paise integer not null check (base_price_paise > 0),
  commission_basis_points integer not null default 1000
    check (commission_basis_points between 0 and 10000),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.pricing_rules
  (slot_type, base_price_paise, commission_basis_points)
values
  ('NORMAL', 39900, 1000),
  ('PEAK', 49900, 1000);

create table public.fitness_assessments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  age integer not null check (age between 18 and 100),
  weight_kg numeric(5,2) not null check (weight_kg between 20 and 400),
  goals text[] not null default '{}',
  experience_level text not null
    check (experience_level in ('BEGINNER', 'INTERMEDIATE', 'ADVANCED')),
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (customer_id)
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  trainer_id uuid not null references public.trainer_profiles(user_id),
  preferred_trainer_id uuid references public.trainer_profiles(user_id),
  service_zone_id uuid not null references public.service_zones(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  mode public.booking_mode not null,
  status public.booking_status not null default 'PENDING_PAYMENT',
  slot_type public.slot_type not null,
  base_price_paise integer not null check (base_price_paise > 0),
  commission_paise integer not null check (commission_paise >= 0),
  total_paise integer not null check (total_paise > 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at = starts_at + interval '60 minutes'),
  check (total_paise = base_price_paise + commission_paise),
  unique (customer_id, idempotency_key)
);

alter table public.bookings
  add constraint no_overlapping_active_trainer_bookings
  exclude using gist (
    trainer_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
  where (
    status in ('PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS')
  );

create index bookings_customer_start_idx
  on public.bookings(customer_id, starts_at desc);

create index bookings_trainer_start_idx
  on public.bookings(trainer_id, starts_at);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id),
  amount_paise integer not null check (amount_paise > 0),
  status public.payment_status not null default 'PENDING',
  idempotency_key text not null unique,
  provider_reference text,
  created_at timestamptz not null default now()
);

create table public.packages (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  sessions_purchased integer not null check (sessions_purchased > 0),
  created_at timestamptz not null default now()
);

create table public.package_ledger (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.packages(id),
  booking_id uuid not null references public.bookings(id),
  entry_type text not null check (
    entry_type in ('PURCHASE', 'USE', 'RESTORE', 'REFUND')
  ),
  sessions_delta integer not null check (sessions_delta <> 0),
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table public.session_records (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id),
  started_at timestamptz,
  ends_at timestamptz,
  warning_sent_at timestamptz,
  exercises jsonb not null default '[]'::jsonb,
  duration_minutes integer,
  trainer_notes text,
  customer_feedback text,
  suggested_next_workout text,
  created_at timestamptz not null default now(),
  check (
    started_at is null
    or ends_at = started_at + interval '60 minutes'
  )
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id),
  booking_id uuid not null references public.bookings(id),
  event_type text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SENT', 'FAILED')),
  deduplication_key text not null unique,
  created_at timestamptz not null default now()
);

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  input_snapshot jsonb not null,
  recommendation jsonb not null,
  created_at timestamptz not null default now()
);

-- Protect every table from direct access until explicit policies exist.
alter table public.profiles enable row level security;
alter table public.service_zones enable row level security;
alter table public.trainer_profiles enable row level security;
alter table public.trainer_availability enable row level security;
alter table public.pricing_rules enable row level security;
alter table public.fitness_assessments enable row level security;
alter table public.bookings enable row level security;
alter table public.payments enable row level security;
alter table public.packages enable row level security;
alter table public.package_ledger enable row level security;
alter table public.session_records enable row level security;
alter table public.notifications enable row level security;
alter table public.recommendations enable row level security;

insert into public.service_zones (name, timezone)
values ('Kolkata Demo Zone', 'Asia/Kolkata');