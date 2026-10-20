"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("customer@zuryo.demo");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const supabase = createClient();

      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setError(error.message);
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", (
          await supabase.auth.getUser()
        ).data.user?.id ?? "")
        .single();

      if (profileError || !profile) {
        await supabase.auth.signOut();
        setError("Account profile missing. Contact administrator.");
        return;
      }

      const destinations = {
        CUSTOMER: "/customer",
        TRAINER: "/trainer",
        ADMIN: "/admin",
      } as const;

      router.replace(destinations[profile.role as keyof typeof destinations]);
      router.refresh();
    } catch (err) {
      console.error("Login failure:", err);

      setError(
        err instanceof Error
          ? err.message
          : "Unexpected login error. Check browser console."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-white">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-8"
      >
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-teal-400">
            Zuryo
          </p>
          <h1 className="mt-3 text-3xl font-bold">Welcome back</h1>
          <p className="mt-2 text-sm text-slate-400">
            Sign in to manage your fitness sessions.
          </p>
        </div>

        <label className="block space-y-2">
          <span className="text-sm text-slate-300">Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 outline-none focus:border-teal-400"
          />
        </label>

        <label className="block space-y-2">
          <span className="text-sm text-slate-300">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 outline-none focus:border-teal-400"
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-teal-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}