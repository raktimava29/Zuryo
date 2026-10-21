import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const [{ data: catalog, error: catalogError }, { data: packages, error: packagesError }] = await Promise.all([
    supabase.from("package_catalog").select("id,name,session_count,price_paise,validity_days").eq("active", true).order("price_paise"),
    supabase.from("packages").select("id,catalog_id,sessions_purchased,sessions_remaining,expires_at,created_at").eq("customer_id", user.id).gt("sessions_remaining", 0).or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`).order("created_at", { ascending: false }),
  ]);
  if (catalogError || packagesError) {
    console.error("Package listing failed", { catalogCode: catalogError?.code, packagesCode: packagesError?.code });
    return NextResponse.json({ error: "Packages could not be loaded. Apply Phase 3 database migrations first." }, { status: 503 });
  }
  return NextResponse.json({ catalog: catalog ?? [], packages: packages ?? [] });
}
