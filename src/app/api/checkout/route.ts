import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const checkoutSchema = z.object({
  bookingId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(200),
  outcome: z.enum(["SUCCESS", "FAILURE"]),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid checkout request.", details: parsed.error.flatten() }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("complete_simulated_payment", {
    p_booking_id: parsed.data.bookingId,
    p_idempotency_key: parsed.data.idempotencyKey,
    p_succeed: parsed.data.outcome === "SUCCESS",
  });
  if (error) {
    const map: Record<string, { status: number; message: string }> = {
      AUTH_REQUIRED: { status: 401, message: "Authentication required." },
      INVALID_PAYMENT_REQUEST: { status: 400, message: "Invalid checkout request." },
      BOOKING_NOT_FOUND: { status: 404, message: "Booking not found." },
      BOOKING_NOT_PAYABLE: { status: 409, message: "Booking is no longer awaiting payment." },
    };
    const mapped = map[error.message];
    if (mapped) return NextResponse.json({ error: mapped.message, code: error.message }, { status: mapped.status });
    if (error.code === "23505") return NextResponse.json({ error: "Payment request already processed.", code: "PAYMENT_ALREADY_PROCESSED" }, { status: 409 });
    console.error("Simulated checkout failed", { code: error.code, message: error.message });
    return NextResponse.json({ error: "Checkout could not be completed." }, { status: 500 });
  }

  const status = data?.status;
  return NextResponse.json({ booking: data, paymentStatus: status === "CONFIRMED" ? "SUCCEEDED" : status === "PAYMENT_FAILED" ? "FAILED" : "PENDING" }, { status: 200 });
}
