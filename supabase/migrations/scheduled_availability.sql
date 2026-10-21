-- Supports both instant and scheduled availability without weakening booking RPC checks.
create or replace function public.get_available_trainers_for_slot(
  p_service_zone_id uuid,
  p_starts_at timestamptz,
  p_mode public.booking_mode
)
returns table (trainer_id uuid, full_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_user_id and p.role = 'CUSTOMER'::public.app_role
  ) then
    raise exception 'CUSTOMER_ROLE_REQUIRED' using errcode = '42501';
  end if;

  if p_service_zone_id is null or p_starts_at is null or p_mode is null then
    raise exception 'INVALID_AVAILABILITY_QUERY' using errcode = '22023';
  end if;

  if p_mode = 'INSTANT'::public.booking_mode then
    if p_starts_at <= v_now or p_starts_at > v_now + interval '60 minutes' then
      raise exception 'INVALID_BOOKING_TIME' using errcode = '22023';
    end if;
  elsif p_starts_at < v_now + interval '60 minutes' then
    raise exception 'INVALID_BOOKING_TIME' using errcode = '22023';
  end if;

  return query
  select tp.user_id, p.full_name
  from public.trainer_profiles tp
  join public.profiles p on p.id = tp.user_id
  where tp.service_zone_id = p_service_zone_id
    and tp.active = true
    and exists (
      select 1 from public.trainer_availability ta
      where ta.trainer_id = tp.user_id
        and ta.is_available = true
        and ta.starts_at <= p_starts_at
        and ta.ends_at >= p_starts_at + interval '60 minutes'
    )
    and not exists (
      select 1 from public.bookings b
      where b.trainer_id = tp.user_id
        and b.status in (
          'PENDING_PAYMENT'::public.booking_status,
          'CONFIRMED'::public.booking_status,
          'IN_PROGRESS'::public.booking_status
        )
        and tstzrange(b.starts_at, b.ends_at, '[)')
          && tstzrange(p_starts_at, p_starts_at + interval '60 minutes', '[)')
    )
  order by p.full_name;
end;
$$;

revoke all on function public.get_available_trainers_for_slot(uuid, timestamptz, public.booking_mode)
from public, anon;
grant execute on function public.get_available_trainers_for_slot(uuid, timestamptz, public.booking_mode)
to authenticated;
