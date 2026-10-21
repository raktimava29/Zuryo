import { requireRole } from "@/lib/auth/require-role";
import { connection } from "next/server";
import { Suspense } from "react";
import BookingPanel from "./booking-panel";

async function CustomerContent() {
  await connection();
  const { profile } = await requireRole(["CUSTOMER"]);
  return <BookingPanel customerName={profile.full_name} />;
}

export default function CustomerPage() {
  return <Suspense fallback={<main className="p-8 text-slate-600">Loading customer dashboard...</main>}><CustomerContent /></Suspense>;
}
