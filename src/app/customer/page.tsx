import { requireRole } from "@/lib/auth/require-role";
import { connection } from "next/server";
import { Suspense } from "react";

async function CustomerContent() {
  await connection();
  const { profile } = await requireRole(["CUSTOMER"]);

  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold">Welcome, {profile.full_name}</h1>
      <p className="mt-2 text-slate-600">
        Book workouts, manage sessions, and track fitness progress.
      </p>
    </main>
  );
}

export default function CustomerPage() {
  return (
    <Suspense fallback={<p>Loading customer dashboard...</p>}>
      <CustomerContent />
    </Suspense>
  );
}