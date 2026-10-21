import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyRazorpayWebhookSignature } from "@/lib/payments/razorpay";

export async function POST(request: Request) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("Razorpay webhook secret is not configured");
    return NextResponse.json({ error: "Webhook is not configured." }, { status: 503 });
  }
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  if (!verifyRazorpayWebhookSignature(rawBody, signature, webhookSecret)) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  let event: {
    event?: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number } } };
  };
  try { event = JSON.parse(rawBody) as typeof event; }
  catch { return NextResponse.json({ error: "Invalid webhook payload." }, { status: 400 }); }

  const eventId = request.headers.get("x-razorpay-event-id");
  const eventType = event.event;
  if (!eventId || !eventType) return NextResponse.json({ error: "Missing webhook event metadata." }, { status: 400 });
  if (eventType !== "payment.captured" && eventType !== "payment.failed") {
    return NextResponse.json({ received: true, ignored: true });
  }
  const payment = event.payload?.payment?.entity;
  if (!payment?.order_id || !payment.id || !Number.isSafeInteger(payment.amount)) {
    return NextResponse.json({ error: "Missing payment fields." }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("process_razorpay_webhook", {
      p_event_id: eventId,
      p_event_type: eventType,
      p_order_id: payment.order_id,
      p_payment_id: payment.id,
      p_amount_paise: payment.amount,
    });
    if (error) {
      console.error("Razorpay webhook processing failed", { code: error.code, message: error.message });
      return NextResponse.json({ error: "Webhook processing failed." }, { status: 500 });
    }
    return NextResponse.json({ received: true, result: data });
  } catch (error) {
    console.error("Razorpay webhook configuration/processing failed", error);
    return NextResponse.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
