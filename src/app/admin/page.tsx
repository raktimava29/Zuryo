import { requireRole } from "@/lib/auth/require-role";
import { connection } from "next/server";
import { Suspense } from "react";

async function AdminContent() {
  await connection();
  const { profile } = await requireRole(["ADMIN"]);

  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold">Operations dashboard</h1>
      <p className="mt-2">Welcome, {profile.full_name}</p>
    </main>
  );
}

export default function AdminPage() {
  return (
    <Suspense fallback={<p>Loading customer dashboard...</p>}>
      <AdminContent />
    </Suspense>
  );
}