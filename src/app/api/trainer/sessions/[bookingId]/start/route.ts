import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const paramsSchema = z.string().uuid();

export async function POST(_request: Request, context: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = await context.params;
  if (!paramsSchema.safeParse(bookingId).success) {
    return NextResponse.json({ error: "INVALID_BOOKING_ID" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const { data, error } = await supabase.rpc("start_training_session", { p_booking_id: bookingId });
  if (error) {
    const message = error.message;
    const status = message.includes("BOOKING_NOT_FOUND") ? 404
      : message.includes("AUTH_REQUIRED") ? 401
      : message.includes("SESSION_NOT_STARTED_YET") || message.includes("BOOKING_NOT_CONFIRMED") ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
  return NextResponse.json({ session: data });
}
