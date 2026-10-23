alter table public.payments
  add column if not exists refunded_at timestamptz;

create table if not exists public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  provider_refund_id text not null unique,
  event_id text not null unique,
  amount_paise integer not null check (amount_paise > 0),
  processed_at timestamptz not null default clock_timestamp()
);

create index if not exists payment_refunds_payment_id_idx
  on public.payment_refunds(payment_id);

alter table public.payment_refunds enable row level security;

-- No client policies: refund records are written only by the verified server webhook.
revoke all on public.payment_refunds from public, anon, authenticated;
grant select on public.payment_refunds to service_role;

create or replace function public.process_razorpay_refund_webhook(
  p_event_id text,
  p_refund_id text,
  p_provider_payment_id text,
  p_amount_paise integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_booking public.bookings%rowtype;
  v_package public.packages%rowtype;
  v_existing_refund public.payment_refunds%rowtype;
  v_refunded_total bigint;
  v_sessions_to_revoke integer;
  v_full_refund boolean;
  v_booking_reconciliation_required boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  if p_event_id is null or length(trim(p_event_id)) = 0
     or p_refund_id is null or length(trim(p_refund_id)) = 0
     or p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0
     or p_amount_paise is null or p_amount_paise <= 0 then
    raise exception 'INVALID_REFUND_EVENT' using errcode = '22023';
  end if;

  select * into v_existing_refund
    from public.payment_refunds
   where provider_refund_id = p_refund_id;
  if found then
    return jsonb_build_object('processed', false, 'reason', 'DUPLICATE_REFUND');
  end if;

  insert into public.payment_webhook_events(event_id, event_type)
  values (p_event_id, 'refund.processed')
  on conflict (event_id) do nothing;
  if not found then
    return jsonb_build_object('processed', false, 'reason', 'DUPLICATE_EVENT');
  end if;

  select * into v_payment
    from public.payments
   where provider_payment_id = p_provider_payment_id
   for update;
  if not found then
    delete from public.payment_webhook_events where event_id = p_event_id;
    raise exception 'PAYMENT_NOT_FOUND_FOR_REFUND';
  end if;

  if v_payment.status not in ('SUCCEEDED'::public.payment_status, 'REFUNDED'::public.payment_status) then
    delete from public.payment_webhook_events where event_id = p_event_id;
    raise exception 'PAYMENT_NOT_REFUNDABLE';
  end if;

  select coalesce(sum(amount_paise), 0) into v_refunded_total
    from public.payment_refunds
   where payment_id = v_payment.id;
  if v_refunded_total + p_amount_paise > v_payment.amount_paise then
    delete from public.payment_webhook_events where event_id = p_event_id;
    raise exception 'REFUND_AMOUNT_EXCEEDS_PAYMENT';
  end if;

  insert into public.payment_refunds(payment_id, provider_refund_id, event_id, amount_paise)
  values (v_payment.id, p_refund_id, p_event_id, p_amount_paise);
  v_refunded_total := v_refunded_total + p_amount_paise;
  v_full_refund := v_refunded_total >= v_payment.amount_paise;

  if v_full_refund then
    update public.payments
       set status = 'REFUNDED'::public.payment_status,
           refunded_at = coalesce(refunded_at, clock_timestamp()),
           updated_at = clock_timestamp()
     where id = v_payment.id;

    if v_payment.package_catalog_id is not null then
      select * into v_package
        from public.packages
       where payment_id = v_payment.id
       for update;
      if found and v_package.sessions_remaining > 0 then
        v_sessions_to_revoke := v_package.sessions_remaining;
        update public.packages
           set sessions_remaining = 0
         where id = v_package.id;
        insert into public.package_ledger(
          package_id, booking_id, payment_id, entry_type,
          sessions_delta, idempotency_key, notes
        ) values (
          v_package.id, null, v_payment.id, 'REFUND',
          -v_sessions_to_revoke,
          'package-refund:' || v_payment.id::text,
          'Remaining credits revoked after provider-confirmed full refund'
        ) on conflict (idempotency_key) do nothing;
      end if;
    elsif v_payment.booking_id is not null then
      select * into v_booking from public.bookings where id = v_payment.booking_id;
      if found and v_booking.status <> 'CANCELLED' then
        v_booking_reconciliation_required := true;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'processed', true,
    'full_refund', v_full_refund,
    'payment_status', case when v_full_refund then 'REFUNDED' else 'SUCCEEDED' end,
    'booking_reconciliation_required', v_booking_reconciliation_required
  );
end;
$$;

revoke all on function public.process_razorpay_refund_webhook(text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.process_razorpay_refund_webhook(text, text, text, integer)
  to service_role;

-- Tighten package-credit restoration: only admin, cancelled booking, a real prior
-- USE ledger entry, one restoration per booking, and an unexpired package.
create or replace function public.restore_package_credit(
  p_booking_id uuid,
  p_reason text default 'Booking cancelled'
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_package public.packages%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles where id = auth.uid() and role = 'ADMIN'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;
  if not found or v_booking.status <> 'CANCELLED'
     or v_booking.payment_method <> 'PACKAGE'
     or v_booking.package_id is null then
    return false;
  end if;

  if not exists (
    select 1 from public.package_ledger
     where booking_id = p_booking_id and entry_type = 'USE'
  ) or exists (
    select 1 from public.package_ledger
     where booking_id = p_booking_id and entry_type = 'RESTORE'
  ) then
    return false;
  end if;

  select * into v_package
    from public.packages
   where id = v_booking.package_id
   for update;
  if not found or (v_package.expires_at is not null and v_package.expires_at <= clock_timestamp()) then
    return false;
  end if;

  update public.packages
     set sessions_remaining = sessions_remaining + 1
   where id = v_package.id;

  insert into public.package_ledger(
    package_id, booking_id, entry_type, sessions_delta, idempotency_key, notes
  ) values (
    v_package.id, p_booking_id, 'RESTORE', 1,
    'package-restore:' || p_booking_id::text,
    left(coalesce(p_reason, 'Booking cancelled'), 500)
  );
  return true;
end;
$$;

revoke all on function public.restore_package_credit(uuid, text) from public, anon;
grant execute on function public.restore_package_credit(uuid, text) to authenticated;
