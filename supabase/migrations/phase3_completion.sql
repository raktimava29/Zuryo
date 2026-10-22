alter table public.payments alter column booking_id drop not null;
alter table public.payments add column if not exists package_catalog_id uuid references public.package_catalog(id);
alter table public.payments drop constraint if exists payments_booking_id_key;
create unique index if not exists payments_one_payment_per_booking_idx on public.payments(booking_id) where booking_id is not null;
create unique index if not exists payments_one_pending_package_order_idx on public.payments(provider_order_id) where provider_order_id is not null;
alter table public.bookings add column if not exists payment_method text not null default 'RAZORPAY' check (payment_method in ('RAZORPAY','PACKAGE'));
alter table public.bookings add column if not exists package_id uuid references public.packages(id);
create unique index if not exists packages_payment_id_unique_idx on public.packages(payment_id) where payment_id is not null;

create or replace function public.record_razorpay_order(p_booking_id uuid, p_order_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid(); v_booking public.bookings%rowtype;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  if p_order_id is null or length(trim(p_order_id))<5 or length(p_order_id)>100 then raise exception 'INVALID_PAYMENT_REQUEST'; end if;
  select * into v_booking from public.bookings where id=p_booking_id and customer_id=v_user_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.status<>'PENDING_PAYMENT' then raise exception 'BOOKING_NOT_PAYABLE'; end if;
  insert into public.payments(booking_id,amount_paise,status,idempotency_key,provider_reference,provider_order_id)
  values(v_booking.id,v_booking.total_paise,'PENDING','razorpay-order:'||p_order_id,p_order_id,p_order_id)
  on conflict (booking_id) where booking_id is not null do update set
    provider_order_id=excluded.provider_order_id,provider_reference=excluded.provider_reference,updated_at=clock_timestamp()
    where public.payments.status='PENDING';
  if not exists(select 1 from public.payments where booking_id=v_booking.id and provider_order_id=p_order_id) then raise exception 'PAYMENT_ALREADY_PROCESSED'; end if;
end; $$;
revoke all on function public.record_razorpay_order(uuid,text) from public,anon;
grant execute on function public.record_razorpay_order(uuid,text) to authenticated;

create or replace function public.record_razorpay_package_order(p_catalog_id uuid, p_order_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid(); v_catalog public.package_catalog%rowtype;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  if p_order_id is null or length(trim(p_order_id)) < 5 or length(p_order_id) > 100 then raise exception 'INVALID_PAYMENT_REQUEST'; end if;
  select * into v_catalog from public.package_catalog where id=p_catalog_id and active=true;
  if not found then raise exception 'PACKAGE_NOT_FOUND'; end if;
  insert into public.payments(booking_id, package_catalog_id, amount_paise, status, idempotency_key, provider_reference, provider_order_id)
  values (null, v_catalog.id, v_catalog.price_paise, 'PENDING', 'razorpay-package:'||p_order_id, p_order_id, p_order_id)
  on conflict (idempotency_key) do nothing;
  if not exists(select 1 from public.payments where provider_order_id=p_order_id and package_catalog_id=v_catalog.id and status='PENDING') then raise exception 'PAYMENT_ALREADY_PROCESSED'; end if;
end; $$;
revoke all on function public.record_razorpay_package_order(uuid,text) from public, anon;
grant execute on function public.record_razorpay_package_order(uuid,text) to authenticated;

create or replace function public.process_razorpay_webhook(
  p_event_id text, p_event_type text, p_order_id text, p_payment_id text, p_amount_paise integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_payment public.payments%rowtype; v_booking public.bookings%rowtype; v_catalog public.package_catalog%rowtype; v_customer_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
  raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
end if;
  if p_event_id is null or p_event_type is null or p_order_id is null or p_payment_id is null then raise exception 'INVALID_WEBHOOK_EVENT'; end if;
  insert into public.payment_webhook_events(event_id,event_type) values(p_event_id,p_event_type) on conflict(event_id) do nothing;
  if not found then return jsonb_build_object('processed',false,'reason','DUPLICATE_EVENT'); end if;
  select * into v_payment from public.payments where provider_order_id=p_order_id for update;
  if not found then delete from public.payment_webhook_events where event_id=p_event_id; raise exception 'PAYMENT_ORDER_NOT_FOUND'; end if;
  if p_amount_paise is null or p_amount_paise <> v_payment.amount_paise then delete from public.payment_webhook_events where event_id=p_event_id; raise exception 'PAYMENT_AMOUNT_MISMATCH'; end if;
  if p_event_type not in ('payment.captured','payment.failed') then return jsonb_build_object('processed',true,'ignored',true); end if;
  if v_payment.package_catalog_id is not null then
    select * into v_catalog from public.package_catalog where id=v_payment.package_catalog_id;
    if not found then delete from public.payment_webhook_events where event_id=p_event_id; raise exception 'PACKAGE_NOT_FOUND'; end if;
    select customer_id into v_customer_id from public.payment_order_metadata where provider_order_id=p_order_id;
    -- Metadata table is populated by authenticated order RPC below; avoids trusting webhook notes for ownership.
    if v_customer_id is null then delete from public.payment_webhook_events where event_id=p_event_id; raise exception 'PACKAGE_CUSTOMER_NOT_FOUND'; end if;
    if p_event_type='payment.captured' then
      if v_payment.status='SUCCEEDED' then return jsonb_build_object('processed',false,'reason','ALREADY_PAID'); end if;
      update public.payments set status='SUCCEEDED',provider_payment_id=p_payment_id,paid_at=clock_timestamp(),updated_at=clock_timestamp() where id=v_payment.id;
      insert into public.packages(customer_id,catalog_id,sessions_purchased,sessions_remaining,expires_at,payment_id)
      values(v_customer_id,v_catalog.id,v_catalog.session_count,v_catalog.session_count,clock_timestamp()+make_interval(days=>v_catalog.validity_days),v_payment.id)
      on conflict (payment_id) where payment_id is not null do nothing;
      if not exists(select 1 from public.package_ledger where payment_id=v_payment.id and entry_type='PURCHASE') then
        insert into public.package_ledger(package_id,booking_id,payment_id,entry_type,sessions_delta,idempotency_key,notes)
        select id,null,v_payment.id,'PURCHASE',sessions_purchased,'package-purchase:'||v_payment.id::text,'Package purchase credit' from public.packages where payment_id=v_payment.id;
      end if;
    else
      if v_payment.status='PENDING' then update public.payments set status='FAILED',provider_payment_id=p_payment_id,updated_at=clock_timestamp() where id=v_payment.id; end if;
    end if;
    return jsonb_build_object('processed',true,'purchase_type','PACKAGE','payment_status',p_event_type);
  end if;
  select * into v_booking from public.bookings where id=v_payment.booking_id for update;
  if not found then delete from public.payment_webhook_events where event_id=p_event_id; raise exception 'BOOKING_NOT_FOUND'; end if;
  if p_event_type='payment.captured' then
    if v_payment.status='SUCCEEDED' then return jsonb_build_object('processed',false,'reason','ALREADY_PAID'); end if;
    if v_booking.status <> 'PENDING_PAYMENT' then delete from public.payment_webhook_events where event_id=p_event_id; raise exception 'BOOKING_NOT_PAYABLE'; end if;
    update public.payments set status='SUCCEEDED',provider_payment_id=p_payment_id,paid_at=clock_timestamp(),updated_at=clock_timestamp() where id=v_payment.id;
    update public.bookings set status='CONFIRMED',updated_at=clock_timestamp() where id=v_booking.id;
    insert into public.notifications(recipient_id,booking_id,event_type,deduplication_key) values(v_booking.trainer_id,v_booking.id,'BOOKING_CONFIRMED','booking-confirmed:'||v_booking.id::text) on conflict(deduplication_key) do nothing;
  else
    if v_payment.status='PENDING' and v_booking.status='PENDING_PAYMENT' then
      update public.payments set status='FAILED',provider_payment_id=p_payment_id,updated_at=clock_timestamp() where id=v_payment.id;
      update public.bookings set status='PAYMENT_FAILED',updated_at=clock_timestamp() where id=v_booking.id;
      insert into public.notifications(recipient_id,booking_id,event_type,deduplication_key) values(v_booking.customer_id,v_booking.id,'PAYMENT_FAILED','payment-failed:'||v_booking.id::text) on conflict(deduplication_key) do nothing;
    end if;
  end if;
  return jsonb_build_object('processed',true,'booking_status',(select status::text from public.bookings where id=v_booking.id));
end; $$;
revoke all on function public.process_razorpay_webhook(text,text,text,text,integer) from public, anon, authenticated;
grant execute on function public.process_razorpay_webhook(text,text,text,text,integer) to service_role;

-- Secure ownership metadata for package checkout orders.
create table if not exists public.payment_order_metadata(
  provider_order_id text primary key,
  customer_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.payment_order_metadata enable row level security;
create policy "Customers read own payment order metadata" on public.payment_order_metadata for select to authenticated using(customer_id=(select auth.uid()));
-- Replace RPC to persist customer ID transactionally with payment order.
create or replace function public.record_razorpay_package_order(p_catalog_id uuid,p_order_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid:=auth.uid(); v_catalog public.package_catalog%rowtype;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  if p_order_id is null or length(trim(p_order_id))<5 or length(p_order_id)>100 then raise exception 'INVALID_PAYMENT_REQUEST'; end if;
  select * into v_catalog from public.package_catalog where id=p_catalog_id and active=true;
  if not found then raise exception 'PACKAGE_NOT_FOUND'; end if;
  insert into public.payments(booking_id,package_catalog_id,amount_paise,status,idempotency_key,provider_reference,provider_order_id)
  values(null,v_catalog.id,v_catalog.price_paise,'PENDING','razorpay-package:'||p_order_id,p_order_id,p_order_id) on conflict(idempotency_key) do nothing;
  insert into public.payment_order_metadata(provider_order_id,customer_id) values(p_order_id,v_user_id) on conflict(provider_order_id) do nothing;
  if not exists(select 1 from public.payments where provider_order_id=p_order_id and package_catalog_id=v_catalog.id and status='PENDING') then raise exception 'PAYMENT_ALREADY_PROCESSED'; end if;
end; $$;
revoke all on function public.record_razorpay_package_order(uuid,text) from public,anon;
grant execute on function public.record_razorpay_package_order(uuid,text) to authenticated;

create or replace function public.redeem_package_for_booking(p_booking_id uuid,p_package_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid:=auth.uid(); v_booking public.bookings%rowtype; v_package public.packages%rowtype;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  select * into v_booking from public.bookings where id=p_booking_id and customer_id=v_user_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.status<>'PENDING_PAYMENT' then raise exception 'BOOKING_NOT_PAYABLE'; end if;
  select * into v_package from public.packages where id=p_package_id and customer_id=v_user_id for update;
  if not found then raise exception 'PACKAGE_NOT_FOUND'; end if;
  if v_package.sessions_remaining<=0 then raise exception 'PACKAGE_EMPTY'; end if;
  if v_package.expires_at is not null and v_package.expires_at<=clock_timestamp() then raise exception 'PACKAGE_EXPIRED'; end if;
  update public.packages set sessions_remaining=sessions_remaining-1 where id=v_package.id;
  update public.bookings set status='CONFIRMED',payment_method='PACKAGE',package_id=v_package.id,updated_at=clock_timestamp() where id=v_booking.id returning * into v_booking;
  insert into public.package_ledger(package_id,booking_id,entry_type,sessions_delta,idempotency_key,notes)
  values(v_package.id,v_booking.id,'USE',-1,'package-use:'||v_booking.id::text,'Redeemed for confirmed booking') on conflict(idempotency_key) do nothing;
  insert into public.notifications(recipient_id,booking_id,event_type,deduplication_key)
  values(v_booking.trainer_id,v_booking.id,'BOOKING_CONFIRMED','booking-confirmed:'||v_booking.id::text) on conflict(deduplication_key) do nothing;
  return jsonb_build_object('booking_id',v_booking.id,'status',v_booking.status,'payment_method',v_booking.payment_method,'package_id',v_package.id,'sessions_remaining',v_package.sessions_remaining-1);
end; $$;
revoke all on function public.redeem_package_for_booking(uuid,uuid) from public,anon;
grant execute on function public.redeem_package_for_booking(uuid,uuid) to authenticated;

-- Refund credits for eligible cancelled package bookings; called by future cancellation/refund flow.
create or replace function public.restore_package_credit(p_booking_id uuid,p_reason text default 'Booking cancelled')
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_booking public.bookings%rowtype;
begin
  if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid() and role='ADMIN') then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  select * into v_booking from public.bookings where id=p_booking_id for update;
  if not found or v_booking.payment_method<>'PACKAGE' or v_booking.package_id is null then return false; end if;
  if exists(select 1 from public.package_ledger where booking_id=p_booking_id and entry_type='RESTORE') then return false; end if;
  update public.packages set sessions_remaining=sessions_remaining+1 where id=v_booking.package_id and (expires_at is null or expires_at>clock_timestamp());
  if not found then return false; end if;
  insert into public.package_ledger(package_id,booking_id,entry_type,sessions_delta,idempotency_key,notes) values(v_booking.package_id,p_booking_id,'RESTORE',1,'package-restore:'||p_booking_id::text,left(p_reason,500));
  return true;
end; $$;
revoke all on function public.restore_package_credit(uuid,text) from public,anon;
grant execute on function public.restore_package_credit(uuid,text) to authenticated;
