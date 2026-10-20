import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const bookingSchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  serviceZoneId: z.string().uuid(),
  mode: z.enum(["INSTANT", "SCHEDULED"]),
  idempotencyKey: z.string().min(8).max(200),
  preferredTrainerId: z.string().uuid().nullable().optional(),
});

const errorMap: Record<string, { status: number; message: string }> = {
  AUTH_REQUIRED: {
    status: 401,
    message: "Authentication required.",
  },
  CUSTOMER_PROFILE_REQUIRED: {
    status: 403,
    message: "Customer account required.",
  },
  SERVICE_ZONE_NOT_FOUND: {
    status: 400,
    message: "Selected service zone does not exist.",
  },
  INSTANT_START_OUTSIDE_WINDOW: {
    status: 400,
    message: "Instant booking must start within 60 minutes.",
  },
  SCHEDULED_START_TOO_SOON: {
    status: 400,
    message: "Scheduled booking must start at least 60 minutes ahead.",
  },
  NO_TRAINER_AVAILABLE: {
    status: 409,
    message: "No eligible trainer available for this slot.",
  },
  PRICING_RULE_UNAVAILABLE: {
    status: 503,
    message: "Pricing temporarily unavailable.",
  },
  INVALID_IDEMPOTENCY_KEY: {
    status: 400,
    message: "Invalid idempotency key.",
  },
  MISSING_BOOKING_FIELDS: {
    status: 400,
    message: "Required booking fields missing.",
  },
};

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const parsed = bookingSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid booking request.",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const input = parsed.data;

  const { data, error } = await supabase.rpc("create_booking", {
    p_starts_at: input.startsAt,
    p_service_zone_id: input.serviceZoneId,
    p_mode: input.mode,
    p_idempotency_key: input.idempotencyKey,
    p_preferred_trainer_id: input.preferredTrainerId ?? null,
  });

  if (error) {
    const mapped = errorMap[error.message];

    if (mapped) {
      return NextResponse.json(
        { error: mapped.message, code: error.message },
        { status: mapped.status },
      );
    }

    if (
      error.code === "23P01" ||
      error.code === "23505"
    ) {
      return NextResponse.json(
        {
          error: "Booking conflict. Refresh availability and retry.",
          code: "BOOKING_CONFLICT",
        },
        { status: 409 },
      );
    }

    console.error("Booking RPC failed", {
      code: error.code,
      message: error.message,
    });

    return NextResponse.json(
      { error: "Booking could not be created." },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { booking: data },
    { status: 201 },
  );
}