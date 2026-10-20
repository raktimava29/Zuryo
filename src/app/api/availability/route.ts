
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const querySchema = z.object({
  serviceZoneId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }),
});

export async function GET(request: NextRequest) {
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

  const parsed = querySchema.safeParse({
    serviceZoneId: request.nextUrl.searchParams.get("serviceZoneId"),
    startsAt: request.nextUrl.searchParams.get("startsAt"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid availability query." },
      { status: 400 },
    );
  }

  const { serviceZoneId, startsAt } = parsed.data;
  const startDate = new Date(startsAt);

  if (
    !Number.isFinite(startDate.getTime()) ||
    startDate.getTime() <= Date.now() ||
    startDate.getTime() > Date.now() + 60 * 60 * 1000
  ) {
    return NextResponse.json(
      { error: "Instant bookings must start within the next 60 minutes." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("get_available_trainers", {
    p_service_zone_id: serviceZoneId,
    p_starts_at: startDate.toISOString(),
  });

  if (error) {
    if (error.message.includes("AUTH_REQUIRED")) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 },
      );
    }

    if (error.message.includes("CUSTOMER_ROLE_REQUIRED")) {
      return NextResponse.json(
        { error: "Customer account required." },
        { status: 403 },
      );
    }

    if (error.message.includes("INVALID_BOOKING_TIME")) {
      return NextResponse.json(
        { error: "Invalid booking time." },
        { status: 400 },
      );
    }

    console.error("Availability RPC failed:", error.code);

    return NextResponse.json(
      { error: "Could not retrieve availability." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    trainers: data ?? [],
    startsAt: startDate.toISOString(),
    durationMinutes: 60,
  });
}
