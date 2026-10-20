import { requireRole } from "@/lib/auth/require-role";
import { connection } from "next/server";
import { Suspense } from "react";

async function TrainerContent() {
  await connection();
  const { profile } = await requireRole(["TRAINER"]);

  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold">Trainer workspace</h1>
      <p className="mt-2">Welcome, {profile.full_name}</p>
    </main>
  );
}

export default function TrainerPage() {
  return (
    <Suspense fallback={<p>Loading customer dashboard...</p>}>
      <TrainerContent />
    </Suspense>
  );
}