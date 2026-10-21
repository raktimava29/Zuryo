import { requireRole } from "@/lib/auth/require-role";
import { connection } from "next/server";
import { Suspense } from "react";
import TrainerDashboard from "./trainer-dashboard";

async function TrainerContent() {
  await connection();
  const { profile } = await requireRole(["TRAINER"]);
  return <TrainerDashboard trainerName={profile.full_name} />;
}

export default function TrainerPage() {
  return <Suspense fallback={<main className="p-8 text-slate-600">Loading trainer workspace…</main>}><TrainerContent /></Suspense>;
}
