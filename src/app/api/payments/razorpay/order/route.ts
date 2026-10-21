import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createRazorpayOrder } from "@/lib/payments/razorpay";

const schema = z.object({ bookingId: z.string().uuid() });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let json: unknown;
  try { json = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "Invalid payment request." }, { status: 400 });

  const { data: booking, error } = await supabase
    .from("bookings")
    .select("id,customer_id,status,total_paise")
    .eq("id", parsed.data.bookingId)
    .eq("customer_id", user.id)
    .maybeSingle();
  if (error) {
    console.error("Booking lookup for payment failed", { code: error.code });
    return NextResponse.json({ error: "Payment could not be started." }, { status: 500 });
  }
  if (!booking) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  if (booking.status !== "PENDING_PAYMENT") return NextResponse.json({ error: "Booking is no longer awaiting payment." }, { status: 409 });

  const razorpayKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? process.env.RAZORPAY_KEY_ID ?? process.env.RAZORPAY_KEY;
  if (!razorpayKeyId) {
    return NextResponse.json({ error: "Payment provider is not configured." }, { status: 503 });
  }

  try {
    const order = await createRazorpayOrder({
      amountPaise: booking.total_paise,
      receipt: booking.id,
      notes: { booking_id: booking.id, customer_id: user.id },
    });
    const { error: updateError } = await supabase.rpc("record_razorpay_order", {
      p_booking_id: booking.id,
      p_order_id: order.id,
    });
    if (updateError) {
      console.error("Razorpay order persistence failed", { code: updateError.code, message: updateError.message });
      return NextResponse.json({ error: "Payment could not be started." }, { status: 500 });
    }
    return NextResponse.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: razorpayKeyId });
  } catch (err) {
    if (err instanceof Error && err.message === "RAZORPAY_NOT_CONFIGURED") {
      return NextResponse.json({ error: "Payment provider is not configured." }, { status: 503 });
    }
    console.error("Razorpay order route failed", err);
    return NextResponse.json({ error: "Payment could not be started." }, { status: 502 });
  }
}
