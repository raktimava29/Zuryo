import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AppRole = "CUSTOMER" | "TRAINER" | "ADMIN";

export async function requireRole(allowedRoles: AppRole[]) {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect("/login");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    throw new Error("User profile not configured");
  }

  if (!allowedRoles.includes(profile.role as AppRole)) {
    redirect("/unauthorized");
  }

  return { user, profile, supabase };
}