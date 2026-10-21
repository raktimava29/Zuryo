create or replace function public.get_trainer_sessions()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trainer_id uuid := auth.uid();
  v_result jsonb;
begin
  if v_trainer_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_trainer_id and p.role = 'TRAINER'
  ) then
    raise exception 'TRAINER_REQUIRED' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id,
    'customer_name', p.full_name,
    'starts_at', b.starts_at,
    'ends_at', b.ends_at,
    'status', b.status,
    'mode', b.mode,
    'session', case when sr.booking_id is null then null else jsonb_build_object(
      'started_at', sr.started_at,
      'ends_at', sr.ends_at,
      'warning_sent_at', sr.warning_sent_at,
      'duration_minutes', sr.duration_minutes,
      'trainer_notes', sr.trainer_notes
    ) end
  ) order by b.starts_at), '[]'::jsonb)
  into v_result
  from public.bookings b
  join public.profiles p on p.id = b.customer_id
  left join public.session_records sr on sr.booking_id = b.id
  where b.trainer_id = v_trainer_id
    and b.status in ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED')
    and (b.starts_at >= now() - interval '2 days' or b.status = 'IN_PROGRESS');

  return v_result;
end;
$$;

create or replace function public.start_training_session(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trainer_id uuid := auth.uid();
  v_booking public.bookings%rowtype;
  v_record public.session_records%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if v_trainer_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select b.* into v_booking
  from public.bookings b
  where b.id = p_booking_id and b.trainer_id = v_trainer_id
  for update;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0002';
  end if;

  select sr.* into v_record
  from public.session_records sr
  where sr.booking_id = p_booking_id
  for update;
  if not found then
    raise exception 'SESSION_RECORD_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_booking.status = 'IN_PROGRESS' then
    return jsonb_build_object('booking_id', p_booking_id, 'status', v_booking.status,
      'started_at', v_record.started_at, 'ends_at', v_record.ends_at,
      'warning_sent_at', v_record.warning_sent_at, 'server_time', v_now);
  end if;
  if v_booking.status <> 'CONFIRMED' then
    raise exception 'BOOKING_NOT_CONFIRMED' using errcode = '22023';
  end if;
  if v_now < v_booking.starts_at then
    raise exception 'SESSION_NOT_STARTED_YET' using errcode = '22023';
  end if;

  update public.bookings set status = 'IN_PROGRESS', updated_at = v_now
  where id = p_booking_id;
  update public.session_records set started_at = v_now,
    ends_at = v_now + interval '60 minutes', duration_minutes = 60
  where booking_id = p_booking_id returning * into v_record;

  return jsonb_build_object('booking_id', p_booking_id, 'status', 'IN_PROGRESS',
    'started_at', v_record.started_at, 'ends_at', v_record.ends_at,
    'warning_sent_at', v_record.warning_sent_at, 'server_time', v_now);
end;
$$;

create or replace function public.sync_training_session(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trainer_id uuid := auth.uid();
  v_booking public.bookings%rowtype;
  v_record public.session_records%rowtype;
  v_now timestamptz := clock_timestamp();
  v_elapsed interval;
  v_completed boolean := false;
  v_warning boolean := false;
begin
  if v_trainer_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select b.* into v_booking from public.bookings b
  where b.id = p_booking_id and b.trainer_id = v_trainer_id for update;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0002';
  end if;

  select sr.* into v_record from public.session_records sr
  where sr.booking_id = p_booking_id for update;
  if not found then
    raise exception 'SESSION_RECORD_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_booking.status = 'IN_PROGRESS' and v_record.started_at is not null then
    v_elapsed := v_now - v_record.started_at;

    if v_elapsed >= interval '60 minutes' then
      update public.bookings set status = 'COMPLETED', updated_at = v_now
      where id = p_booking_id;
      insert into public.notifications(recipient_id, booking_id, event_type, deduplication_key)
      values (v_booking.customer_id, p_booking_id, 'SESSION_COMPLETED', p_booking_id::text || ':SESSION_COMPLETED')
      on conflict (deduplication_key) do nothing;
      v_completed := true;
    elsif v_elapsed >= interval '55 minutes' and v_record.warning_sent_at is null then
      update public.session_records set warning_sent_at = v_now where booking_id = p_booking_id returning * into v_record;
      insert into public.notifications(recipient_id, booking_id, event_type, deduplication_key)
      values (v_booking.customer_id, p_booking_id, 'SESSION_WARNING_55_MIN', p_booking_id::text || ':SESSION_WARNING_55_MIN')
      on conflict (deduplication_key) do nothing;
      v_warning := true;
    end if;
  end if;

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'status', case when v_completed then 'COMPLETED' else (select b.status from public.bookings b where b.id = p_booking_id) end,
    'started_at', v_record.started_at,
    'ends_at', v_record.ends_at,
    'warning_sent_at', v_record.warning_sent_at,
    'warning_due', (v_record.started_at is not null and v_now - v_record.started_at >= interval '55 minutes'),
    'completed_now', v_completed,
    'warning_created_now', v_warning,
    'server_time', v_now
  );
end;
$$;

revoke all on function public.get_trainer_sessions() from public, anon;
revoke all on function public.start_training_session(uuid) from public, anon;
revoke all on function public.sync_training_session(uuid) from public, anon;
grant execute on function public.get_trainer_sessions() to authenticated;
grant execute on function public.start_training_session(uuid) to authenticated;
grant execute on function public.sync_training_session(uuid) to authenticated;
