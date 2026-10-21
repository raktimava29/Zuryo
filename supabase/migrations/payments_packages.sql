-- Phase 3: Razorpay order persistence, verified webhook transitions, and package credit ledger.
-- Apply after session_lifecycle.sql and all Phase 2 migrations.

alter table public.payments
  add column if not exists provider_order_id text unique,
  add column if not exists provider_payment_id text unique,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists paid_at timestamptz;

create table if not exists public.payment_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);
alter table public.payment_webhook_events enable row level security;

create table if not exists public.package_catalog (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  session_count integer not null check (session_count > 0),
  price_paise integer not null check (price_paise > 0),
  validity_days integer not null check (validity_days > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.package_catalog enable row level security;

alter table public.packages
  add column if not exists catalog_id uuid references public.package_catalog(id),
  add column if not exists sessions_remaining integer,
  add column if not exists expires_at timestamptz,
  add column if not exists payment_id uuid references public.payments(id);

update public.packages
set sessions_remaining = sessions_purchased
where sessions_remaining is null;

alter table public.packages
  alter column sessions_remaining set not null;
alter table public.packages
  add constraint packages_sessions_remaining_nonnegative
  check (sessions_remaining >= 0);

alter table public.package_ledger alter column booking_id drop not null;
alter table public.package_ledger
  add column if not exists payment_id uuid references public.payments(id),
  add column if not exists notes text;
alter table public.package_ledger
  add constraint package_ledger_booking_or_payment
  check (booking_id is not null or payment_id is not null);

create policy "Customers read active package catalog"
on public.package_catalog for select to authenticated
using (active or exists (
  select 1 from public.profiles p
  where p.id = (select auth.uid()) and p.role = 'ADMIN'
));

create policy "Customers read own package ledger"
on public.package_ledger for select to authenticated
using (exists (
  select 1 from public.packages p
  where p.id = package_id and p.customer_id = (select auth.uid())
));

create policy "Customers read own package balances"
on public.packages for select to authenticated
using (customer_id = (select auth.uid()) or exists (
  select 1 from public.profiles p
  where p.id = (select auth.uid()) and p.role = 'ADMIN'
));

create or replace function public.record_razorpay_order(p_booking_id uuid, p_order_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_booking public.bookings%rowtype;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_order_id is null or length(trim(p_order_id)) < 5 or length(p_order_id) > 100 then
    raise exception 'INVALID_PAYMENT_REQUEST';
  end if;
  select * into v_booking from public.bookings
  where id = p_booking_id and customer_id = v_user_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.status <> 'PENDING_PAYMENT' then raise exception 'BOOKING_NOT_PAYABLE'; end if;

  insert into public.payments(booking_id, amount_paise, status, idempotency_key, provider_reference, provider_order_id)
  values (v_booking.id, v_booking.total_paise, 'PENDING', 'razorpay-order:' || p_order_id, p_order_id, p_order_id)
  on conflict (booking_id) do update
    set provider_order_id = excluded.provider_order_id,
        provider_reference = excluded.provider_reference,
        updated_at = clock_timestamp()
    where public.payments.status = 'PENDING';

  if not exists (select 1 from public.payments where booking_id = v_booking.id and provider_order_id = p_order_id) then
    raise exception 'PAYMENT_ALREADY_PROCESSED';
  end if;
end;
$$;
revoke all on function public.record_razorpay_order(uuid, text) from public, anon;
grant execute on function public.record_razorpay_order(uuid, text) to authenticated;

-- Called only after application verifies Razorpay webhook HMAC against raw request body.
create or replace function public.process_razorpay_webhook(
  p_event_id text,
  p_event_type text,
  p_order_id text,
  p_payment_id text,
  p_amount_paise integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_booking public.bookings%rowtype;
  v_status public.payment_status;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_event_id is null or p_event_type is null or p_order_id is null then
    raise exception 'INVALID_WEBHOOK_EVENT';
  end if;
  insert into public.payment_webhook_events(event_id, event_type)
  values (p_event_id, p_event_type) on conflict (event_id) do nothing;
  if not found then return jsonb_build_object('processed', false, 'reason', 'DUPLICATE_EVENT'); end if;

  select * into v_payment from public.payments
  where provider_order_id = p_order_id for update;
  if not found then
    delete from public.payment_webhook_events where event_id = p_event_id;
    raise exception 'PAYMENT_ORDER_NOT_FOUND';
  end if;
  select * into v_booking from public.bookings where id = v_payment.booking_id for update;
  if p_amount_paise is not null and p_amount_paise <> v_payment.amount_paise then
    delete from public.payment_webhook_events where event_id = p_event_id;
    raise exception 'PAYMENT_AMOUNT_MISMATCH';
  end if;

  if p_event_type = 'payment.captured' then
    if v_payment.status = 'SUCCEEDED' then
      return jsonb_build_object('processed', false, 'reason', 'ALREADY_PAID');
    end if;
    if v_booking.status <> 'PENDING_PAYMENT' then
      delete from public.payment_webhook_events where event_id = p_event_id;
      raise exception 'BOOKING_NOT_PAYABLE';
    end if;
    update public.payments set status = 'SUCCEEDED', provider_payment_id = p_payment_id,
      paid_at = clock_timestamp(), updated_at = clock_timestamp() where id = v_payment.id;
    update public.bookings set status = 'CONFIRMED', updated_at = clock_timestamp() where id = v_booking.id;
    insert into public.notifications(recipient_id, booking_id, event_type, deduplication_key)
    values (v_booking.trainer_id, v_booking.id, 'BOOKING_CONFIRMED', 'booking-confirmed:' || v_booking.id::text)
    on conflict (deduplication_key) do nothing;
  elsif p_event_type = 'payment.failed' then
    if v_payment.status = 'PENDING' and v_booking.status = 'PENDING_PAYMENT' then
      update public.payments set status = 'FAILED', provider_payment_id = p_payment_id,
        updated_at = clock_timestamp() where id = v_payment.id;
      update public.bookings set status = 'PAYMENT_FAILED', updated_at = clock_timestamp() where id = v_booking.id;
      insert into public.notifications(recipient_id, booking_id, event_type, deduplication_key)
      values (v_booking.customer_id, v_booking.id, 'PAYMENT_FAILED', 'payment-failed:' || v_booking.id::text)
      on conflict (deduplication_key) do nothing;
    end if;
  else
    update public.payment_webhook_events set event_type = p_event_type where event_id = p_event_id;
    return jsonb_build_object('processed', true, 'ignored', true);
  end if;
  return jsonb_build_object('processed', true, 'booking_status',
    (select status::text from public.bookings where id = v_booking.id));
end;
$$;
revoke all on function public.process_razorpay_webhook(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.process_razorpay_webhook(text, text, text, text, integer) to service_role;
