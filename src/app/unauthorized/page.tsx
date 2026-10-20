import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <main className="mx-auto max-w-xl p-10">
      <h1 className="text-2xl font-bold">Access denied</h1>
      <p className="mt-3 text-slate-600">
        Your account does not have permission to access this page.
      </p>
      <Link className="mt-5 inline-block underline" href="/">
        Return home
      </Link>
    </main>
  );
}