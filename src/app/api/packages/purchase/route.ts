import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createRazorpayOrder } from "@/lib/payments/razorpay";

const schema = z.object({ catalogId: z.string().uuid() });
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid package selection." }, { status: 400 });
  const { data: catalog, error } = await supabase.from("package_catalog").select("id,name,session_count,price_paise,validity_days").eq("id", parsed.data.catalogId).eq("active", true).maybeSingle();
  if (error || !catalog) return NextResponse.json({ error: "Package not found or inactive." }, { status: 404 });
  try {
    const order = await createRazorpayOrder({ amountPaise: catalog.price_paise, receipt: `pkg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`, notes: { purchase_type: "PACKAGE", catalog_id: catalog.id, customer_id: user.id } });
    const { error: persistError } = await supabase.rpc("record_razorpay_package_order", { p_catalog_id: catalog.id, p_order_id: order.id });
    if (persistError) { console.error("Package order persistence failed", { code: persistError.code, message: persistError.message }); return NextResponse.json({ error: "Package checkout could not be started." }, { status: 500 }); }
    const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? process.env.RAZORPAY_KEY_ID ?? process.env.RAZORPAY_KEY;
    if (!keyId) return NextResponse.json({ error: "Payment provider is not configured." }, { status: 503 });
    return NextResponse.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId, package: catalog });
  } catch (err) {
    console.error("Package order creation failed", err);
    return NextResponse.json({ error: "Package checkout could not be started." }, { status: 502 });
  }
}
