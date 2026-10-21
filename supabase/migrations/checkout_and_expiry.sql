-- Phase 2: simulated checkout and safe expiry for abandoned payment holds.
-- Apply after scheduled_availability.sql.

create or replace function public.expire_pending_bookings()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Expire unpaid holds after 10 minutes. This releases exclusion-constraint slots.
  update public.bookings
     set status = 'PAYMENT_FAILED'::public.booking_status,
         updated_at = clock_timestamp()
   where status = 'PENDING_PAYMENT'::public.booking_status
     and created_at < clock_timestamp() - interval '10 minutes';
  get diagnostics v_count = row_count;

  update public.payments p
     set status = 'FAILED'::public.payment_status
    from public.bookings b
   where p.booking_id = b.id
     and p.status = 'PENDING'::public.payment_status
     and b.status = 'PAYMENT_FAILED'::public.booking_status;

  return v_count;
end;
$$;
revoke all on function public.expire_pending_bookings() from public, anon;
grant execute on function public.expire_pending_bookings() to authenticated;

create or replace function public.complete_simulated_payment(
  p_booking_id uuid,
  p_idempotency_key text,
  p_succeed boolean
)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_booking public.bookings;
  v_existing public.payments;
  v_payment_status public.payment_status;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_booking_id is null or p_idempotency_key is null
     or length(trim(p_idempotency_key)) < 8
     or length(p_idempotency_key) > 200 then
    raise exception 'INVALID_PAYMENT_REQUEST' using errcode = '22023';
  end if;

  perform public.expire_pending_bookings();

  select * into v_booking
    from public.bookings
   where id = p_booking_id and customer_id = v_user_id
   for update;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_existing from public.payments where booking_id = p_booking_id;
  if found then
    -- Idempotent retry returns final state; never process payment twice.
    return v_booking;
  end if;

  if v_booking.status <> 'PENDING_PAYMENT'::public.booking_status then
    raise exception 'BOOKING_NOT_PAYABLE' using errcode = 'P0001';
  end if;

  v_payment_status := case when p_succeed
    then 'SUCCEEDED'::public.payment_status
    else 'FAILED'::public.payment_status end;

  insert into public.payments (
    booking_id, amount_paise, status, idempotency_key, provider_reference
  ) values (
    v_booking.id, v_booking.total_paise, v_payment_status,
    p_idempotency_key, 'SIMULATED-' || gen_random_uuid()::text
  );

  update public.bookings
     set status = case when p_succeed
       then 'CONFIRMED'::public.booking_status
       else 'PAYMENT_FAILED'::public.booking_status end,
         updated_at = clock_timestamp()
   where id = v_booking.id
   returning * into v_booking;

  insert into public.notifications (
    recipient_id, booking_id, event_type, deduplication_key
  ) values (
    v_booking.trainer_id, v_booking.id,
    case when p_succeed then 'BOOKING_CONFIRMED' else 'PAYMENT_FAILED' end,
    case when p_succeed then 'booking-confirmed:' else 'payment-failed:' end || v_booking.id::text
  ) on conflict (deduplication_key) do nothing;

  return v_booking;
end;
$$;
revoke all on function public.complete_simulated_payment(uuid, text, boolean) from public, anon;
grant execute on function public.complete_simulated_payment(uuid, text, boolean) to authenticated;
