-- Availability lookup indexes
create index if not exists trainer_availability_lookup_idx
  on public.trainer_availability(trainer_id, starts_at, ends_at)
  where is_available = true;

create index if not exists trainer_profiles_zone_idx
  on public.trainer_profiles(service_zone_id)
  where active = true;

-- RLS: public discovery data
create policy "Read service zones"
on public.service_zones for select
to authenticated
using (true);

create policy "Read active trainers"
on public.trainer_profiles for select
to authenticated
using (active = true);

create policy "Read available slots"
on public.trainer_availability for select
to authenticated
using (is_available = true);

create policy "Read active pricing"
on public.pricing_rules for select
to authenticated
using (active = true);

-- Profiles: users can read their own profile.
create policy "Read own profile"
on public.profiles for select
to authenticated
using (id = (select auth.uid()));

-- Fitness assessments: customer owns assessment.
create policy "Read own assessment"
on public.fitness_assessments for select
to authenticated
using (customer_id = (select auth.uid()));

create policy "Insert own assessment"
on public.fitness_assessments for insert
to authenticated
with check (
  customer_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'CUSTOMER'
  )
);

create policy "Update own assessment"
on public.fitness_assessments for update
to authenticated
using (customer_id = (select auth.uid()))
with check (customer_id = (select auth.uid()));

-- Bookings: customer, assigned trainer, or admin can read.
create policy "Read relevant bookings"
on public.bookings for select
to authenticated
using (
  customer_id = (select auth.uid())
  or trainer_id = (select auth.uid())
  or exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'ADMIN'
  )
);

-- Customers cannot insert or update bookings directly.
-- All booking writes must go through create_booking().
-- No INSERT/UPDATE/DELETE policies intentionally added.

create policy "Read own payments"
on public.payments for select
to authenticated
using (
  exists (
    select 1 from public.bookings b
    where b.id = booking_id
      and (
        b.customer_id = (select auth.uid())
        or b.trainer_id = (select auth.uid())
        or exists (
          select 1 from public.profiles p
          where p.id = (select auth.uid())
            and p.role = 'ADMIN'
        )
      )
  )
);

create policy "Read own packages"
on public.packages for select
to authenticated
using (
  customer_id = (select auth.uid())
  or exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'ADMIN'
  )
);

create policy "Read relevant session records"
on public.session_records for select
to authenticated
using (
  exists (
    select 1 from public.bookings b
    where b.id = booking_id
      and (
        b.customer_id = (select auth.uid())
        or b.trainer_id = (select auth.uid())
        or exists (
          select 1 from public.profiles p
          where p.id = (select auth.uid())
            and p.role = 'ADMIN'
        )
      )
  )
);

create policy "Read own notifications"
on public.notifications for select
to authenticated
using (recipient_id = (select auth.uid()));

create policy "Read own recommendations"
on public.recommendations for select
to authenticated
using (
  customer_id = (select auth.uid())
);

-- Booking creation: customer identity comes from auth.uid().
-- Prices and commission are calculated on server.
create or replace function public.create_booking(
  p_starts_at timestamptz,
  p_service_zone_id uuid,
  p_mode public.booking_mode,
  p_idempotency_key text,
  p_preferred_trainer_id uuid default null
)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid := auth.uid();
  v_booking public.bookings;
  v_trainer_id uuid;
  v_zone_timezone text;
  v_local_start timestamp;
  v_slot_type public.slot_type;
  v_base integer;
  v_commission integer;
  v_total integer;
  v_now timestamptz := clock_timestamp();
  v_end timestamptz;
begin
  if v_customer_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or length(trim(p_idempotency_key)) < 8
     or length(p_idempotency_key) > 200 then
    raise exception 'INVALID_IDEMPOTENCY_KEY'
      using errcode = '22023';
  end if;

  if p_starts_at is null
     or p_service_zone_id is null
     or p_mode is null then
    raise exception 'MISSING_BOOKING_FIELDS'
      using errcode = '22023';
  end if;

  -- Lock customer row to serialize concurrent requests for same customer.
  perform 1
  from public.profiles p
  where p.id = v_customer_id
    and p.role = 'CUSTOMER'
  for update;

  if not found then
    raise exception 'CUSTOMER_PROFILE_REQUIRED'
      using errcode = '42501';
  end if;

  -- Retry returns original booking; key cannot create duplicate booking.
  select * into v_booking
  from public.bookings
  where customer_id = v_customer_id
    and idempotency_key = p_idempotency_key;

  if found then
    return v_booking;
  end if;

  select z.timezone into v_zone_timezone
  from public.service_zones z
  where z.id = p_service_zone_id;

  if not found then
    raise exception 'SERVICE_ZONE_NOT_FOUND'
      using errcode = '22023';
  end if;

  if p_mode = 'INSTANT' then
    if p_starts_at < v_now
       or p_starts_at > v_now + interval '60 minutes' then
      raise exception 'INSTANT_START_OUTSIDE_WINDOW'
        using errcode = '22023';
    end if;
  else
    if p_starts_at < v_now + interval '60 minutes' then
      raise exception 'SCHEDULED_START_TOO_SOON'
        using errcode = '22023';
    end if;
  end if;

  v_end := p_starts_at + interval '60 minutes';
  v_local_start := p_starts_at at time zone v_zone_timezone;

  -- Initial business assumption: peak periods 06:00–09:00
  -- and 17:00–21:00 in service-zone local time.
  if v_local_start::time >= time '06:00'
     and v_local_start::time < time '09:00'
     or v_local_start::time >= time '17:00'
     and v_local_start::time < time '21:00' then
    v_slot_type := 'PEAK';
  else
    v_slot_type := 'NORMAL';
  end if;

  select r.base_price_paise,
         round(
           r.base_price_paise::numeric
           * r.commission_basis_points / 10000
         )::integer
    into v_base, v_commission
  from public.pricing_rules r
  where r.slot_type = v_slot_type
    and r.active = true;

  if not found then
    raise exception 'PRICING_RULE_UNAVAILABLE'
      using errcode = 'P0001';
  end if;

  v_total := v_base + v_commission;

  -- Lock candidate trainer row. Database exclusion constraint
  -- remains final protection against overlapping bookings.
  select t.user_id into v_trainer_id
  from public.trainer_profiles t
  where t.service_zone_id = p_service_zone_id
    and t.active = true
    and (
      p_preferred_trainer_id is null
      or t.user_id = p_preferred_trainer_id
    )
    and exists (
      select 1
      from public.trainer_availability a
      where a.trainer_id = t.user_id
        and a.is_available = true
        and a.starts_at <= p_starts_at
        and a.ends_at >= v_end
    )
    and not exists (
      select 1
      from public.bookings b
      where b.trainer_id = t.user_id
        and b.status in (
          'PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS'
        )
        and tstzrange(b.starts_at, b.ends_at, '[)')
            && tstzrange(p_starts_at, v_end, '[)')
    )
  order by
    case when t.user_id = p_preferred_trainer_id then 0 else 1 end,
    t.user_id
  limit 1
  for update of t;

  if v_trainer_id is null then
    raise exception 'NO_TRAINER_AVAILABLE'
      using errcode = 'P0001';
  end if;

  insert into public.bookings (
    customer_id, trainer_id, preferred_trainer_id,
    service_zone_id, starts_at, ends_at, mode, status,
    slot_type, base_price_paise, commission_paise,
    total_paise, idempotency_key
  )
  values (
    v_customer_id, v_trainer_id, p_preferred_trainer_id,
    p_service_zone_id, p_starts_at, v_end, p_mode,
    'PENDING_PAYMENT', v_slot_type, v_base,
    v_commission, v_total, p_idempotency_key
  )
  returning * into v_booking;

  insert into public.session_records (booking_id)
  values (v_booking.id);

  insert into public.notifications (
    recipient_id, booking_id, event_type, deduplication_key
  )
  values (
    v_trainer_id, v_booking.id, 'BOOKING_ASSIGNED',
    'booking-assigned:' || v_booking.id::text
  );

  return v_booking;
end;
$$;

revoke all on function public.create_booking(
  timestamptz, uuid, public.booking_mode, text, uuid
) from public, anon;

grant execute on function public.create_booking(
  timestamptz, uuid, public.booking_mode, text, uuid
) to authenticated;