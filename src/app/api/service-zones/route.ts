import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("service_zones")
    .select("id, name, timezone")
    .order("name");

  if (error) {
    console.error("Service-zone lookup failed:", error.code);
    return NextResponse.json({ error: "Could not retrieve service zones." }, { status: 500 });
  }

  return NextResponse.json({ serviceZones: data ?? [] });
}
