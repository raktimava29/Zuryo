import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
const schema = z.object({ bookingId: z.string().uuid() });
export async function GET(request: Request) {
  const supabase = await createClient(); const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const parsed = schema.safeParse({ bookingId: new URL(request.url).searchParams.get("bookingId") });
  if (!parsed.success) return NextResponse.json({ error: "Invalid booking ID." }, { status: 400 });
  const { data, error } = await supabase.from("bookings").select("id,status,payment_method,total_paise").eq("id", parsed.data.bookingId).eq("customer_id", user.id).maybeSingle();
  if (error) return NextResponse.json({ error: "Could not retrieve payment status." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  return NextResponse.json({ booking: data });
}
