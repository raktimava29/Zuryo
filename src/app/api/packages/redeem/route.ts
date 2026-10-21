import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
const schema = z.object({ bookingId: z.string().uuid(), packageId: z.string().uuid() });
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  let body: unknown; try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const parsed = schema.safeParse(body); if (!parsed.success) return NextResponse.json({ error: "Invalid package redemption request." }, { status: 400 });
  const { data, error } = await supabase.rpc("redeem_package_for_booking", { p_booking_id: parsed.data.bookingId, p_package_id: parsed.data.packageId });
  if (error) { const map: Record<string,string> = { PACKAGE_EMPTY: "Package has no sessions remaining.", PACKAGE_EXPIRED: "Package has expired.", PACKAGE_NOT_FOUND: "Package not found.", BOOKING_NOT_PAYABLE: "Booking is no longer awaiting payment.", BOOKING_NOT_FOUND: "Booking not found." }; const message=map[error.message]; if (message) return NextResponse.json({ error: message }, { status: 409 }); console.error("Package redemption failed", { code:error.code, message:error.message }); return NextResponse.json({ error: "Package credit could not be applied. Ensure Phase 3 migrations are applied." }, { status: 500 }); }
  return NextResponse.json({ result: data });
}
