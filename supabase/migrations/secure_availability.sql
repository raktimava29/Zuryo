CREATE OR REPLACE FUNCTION public.get_available_trainers(
  p_service_zone_id uuid,
  p_starts_at timestamptz
)
RETURNS TABLE (
  trainer_id uuid,
  full_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = v_user_id
      AND p.role = 'CUSTOMER'::public.app_role
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_ROLE_REQUIRED';
  END IF;

  IF p_service_zone_id IS NULL
     OR p_starts_at IS NULL
     OR p_starts_at <= now()
     OR p_starts_at > now() + interval '60 minutes' THEN
    RAISE EXCEPTION 'INVALID_BOOKING_TIME';
  END IF;

  RETURN QUERY
  SELECT
    tp.user_id,
    p.full_name
  FROM public.trainer_profiles tp
  JOIN public.profiles p
    ON p.id = tp.user_id
  WHERE tp.service_zone_id = p_service_zone_id
    AND tp.active = true
    AND EXISTS (
      SELECT 1
      FROM public.trainer_availability ta
      WHERE ta.trainer_id = tp.user_id
        AND ta.is_available = true
        AND ta.starts_at <= p_starts_at
        AND ta.ends_at >= p_starts_at + interval '60 minutes'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.bookings b
      WHERE b.trainer_id = tp.user_id
        AND b.status IN (
          'PENDING_PAYMENT'::public.booking_status,
          'CONFIRMED'::public.booking_status,
          'IN_PROGRESS'::public.booking_status
        )
        AND tstzrange(b.starts_at, b.ends_at, '[)')
            && tstzrange(
              p_starts_at,
              p_starts_at + interval '60 minutes',
              '[)'
            )
    )
  ORDER BY p.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_available_trainers(uuid, timestamptz)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_available_trainers(uuid, timestamptz)
TO authenticated;