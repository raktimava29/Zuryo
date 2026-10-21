"use client";

import LogoutButton from "@/app/components/logout-button";

import { useCallback, useEffect, useMemo, useState } from "react";

type SessionStatus = "CONFIRMED" | "IN_PROGRESS" | "COMPLETED";
type TrainerSession = {
  id: string;
  customer_name: string;
  starts_at: string;
  ends_at: string;
  status: SessionStatus;
  mode: "INSTANT" | "SCHEDULED";
  session: null | {
    started_at: string | null;
    ends_at: string | null;
    warning_sent_at: string | null;
    duration_minutes: number | null;
    trainer_notes: string | null;
  };
};

type SyncResponse = {
  status: string;
  started_at: string | null;
  ends_at: string | null;
  warning_sent_at: string | null;
  warning_due: boolean;
  completed_now: boolean;
  server_time: string;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
  }).format(new Date(value));
}

function getRemainingSeconds(endsAt: string | null, now: number) {
  if (!endsAt) return null;
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / 1000));
}

function formatCountdown(seconds: number | null) {
  if (seconds === null) return "--:--";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

export default function TrainerDashboard({ trainerName }: { trainerName: string }) {
  const [sessions, setSessions] = useState<TrainerSession[]>([]);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadSessions = useCallback(async () => {
    const response = await fetch("/api/trainer/sessions", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load sessions");
    setSessions(body.sessions as TrainerSession[]);
  }, []);

  useEffect(() => {
    let active = true;
    void loadSessions()
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Could not load sessions"); })
      .finally(() => { if (active) setLoading(false); });
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const refresh = window.setInterval(() => {
      void loadSessions().catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Refresh failed");
      });
    }, 15000);
    return () => { active = false; window.clearInterval(clock); window.clearInterval(refresh); };
  }, [loadSessions]);

  const activeSessions = useMemo(() => sessions.filter((s) => s.status === "IN_PROGRESS"), [sessions]);
  const activeSessionIds = activeSessions.map((session) => session.id).sort().join(",");

  useEffect(() => {
    if (!activeSessionIds) return;
    let active = true;
    const ids = activeSessionIds.split(",");
    const sync = async () => {
      await Promise.all(ids.map(async (id) => {
        try {
          const response = await fetch(`/api/trainer/sessions/${id}/sync`, { method: "POST" });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error ?? "Session sync failed");
          const synced = body.session as SyncResponse;
          if (active && synced.completed_now) {
            setNotice("Session completed.");
          } else if (active && synced.warning_created_now) {
            setNotice("55-minute warning reached.");
          }
        } catch (reason) {
          if (active) setError(reason instanceof Error ? reason.message : "Session sync failed");
        }
      }));
      if (active) await loadSessions();
    };
    void sync();
    const timer = window.setInterval(() => { void sync(); }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [activeSessionIds, loadSessions]);

  async function startSession(session: TrainerSession) {
    setBusyId(session.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/trainer/sessions/${session.id}/start`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not start session");
      setNotice(`Session with ${session.customer_name} started.`);
      await loadSessions();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start session");
    } finally {
      setBusyId(null);
    }
  }

  const upcoming = sessions.filter((s) => s.status === "CONFIRMED");
  const completed = sessions.filter((s) => s.status === "COMPLETED");

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-5 py-10 sm:px-8">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Trainer workspace</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Welcome, {trainerName}</h1>
          <p className="mt-2 text-slate-600">Manage sessions and keep every workout on schedule.</p>
        </div>
        <button onClick={() => void loadSessions()} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50">
          Refresh sessions
        </button>
        <LogoutButton />
      </header>

      {error && <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {notice && <p role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}

      <section className="mb-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Upcoming" value={upcoming.length} />
        <Stat label="In progress" value={activeSessions.length} />
        <Stat label="Completed" value={completed.length} />
      </section>

      <section className="mb-10">
        <div className="mb-4 flex items-center justify-between"><h2 className="text-xl font-bold text-slate-950">Upcoming sessions</h2><span className="text-sm text-slate-500">Times shown in IST</span></div>
        {loading ? <p className="text-slate-600">Loading sessions…</p> : upcoming.length === 0 ? <Empty>No upcoming confirmed sessions.</Empty> :
          <div className="grid gap-4 md:grid-cols-2">{upcoming.map((session) => {
            const canStart = now >= new Date(session.starts_at).getTime();
            return <article key={session.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3"><h3 className="font-bold text-slate-950">{session.customer_name}</h3><Pill>Confirmed</Pill></div>
              <p className="mt-3 text-sm text-slate-600">{formatDate(session.starts_at)}</p>
              <p className="mt-1 text-sm text-slate-500">{session.mode === "INSTANT" ? "Instant booking" : "Scheduled booking"} · 60 minutes</p>
              <button disabled={!canStart || busyId === session.id} onClick={() => void startSession(session)} className="mt-5 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300">
                {busyId === session.id ? "Starting…" : canStart ? "Start session" : `Available at ${formatDate(session.starts_at)}`}
              </button>
            </article>;
          })}</div>}
      </section>

      <section className="mb-10">
        <h2 className="mb-4 text-xl font-bold text-slate-950">Live sessions</h2>
        {activeSessions.length === 0 ? <Empty>No sessions in progress.</Empty> :
          <div className="grid gap-4 md:grid-cols-2">{activeSessions.map((session) => {
            const end = session.session?.ends_at ?? null;
            const remaining = getRemainingSeconds(end, now);
            const elapsed = session.session?.started_at ? Math.max(0, Math.floor((now - new Date(session.session.started_at).getTime()) / 60000)) : 0;
            const warning = elapsed >= 55 || Boolean(session.session?.warning_sent_at);
            return <article key={session.id} className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5">
              <div className="flex items-start justify-between gap-3"><h3 className="font-bold text-slate-950">{session.customer_name}</h3><Pill active>In progress</Pill></div>
              <div className="mt-5 flex items-end justify-between gap-4"><div><p className="text-sm text-slate-600">Time remaining</p><p className="font-mono text-4xl font-bold tabular-nums text-slate-950">{formatCountdown(remaining)}</p></div><p className="text-sm text-slate-500">{elapsed} / 60 min</p></div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-600" style={{ width: `${Math.min(100, elapsed / 60 * 100)}%` }} /></div>
              {warning && <p className="mt-4 rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900">55-minute mark reached. Wrap up safely.</p>}
              {remaining === 0 && <p className="mt-3 text-sm font-semibold text-emerald-800">Session completion syncing with server…</p>}
            </article>;
          })}</div>}
      </section>

      <section>
        <h2 className="mb-4 text-xl font-bold text-slate-950">Recently completed</h2>
        {completed.length === 0 ? <Empty>No completed sessions yet.</Empty> : <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {completed.map((session) => <div key={session.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 last:border-0"><div><p className="font-semibold text-slate-900">{session.customer_name}</p><p className="mt-1 text-sm text-slate-500">{formatDate(session.starts_at)}</p></div><Pill>Completed</Pill></div>)}
        </div>}
      </section>
      <p className="mt-8 text-xs text-slate-500">Dashboard refreshes every 15 seconds. Session timing and status transitions are validated by server-side database functions.</p>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-3xl font-bold text-slate-950">{value}</p></div>;
}
function Pill({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>{children}</span>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-8 text-center text-sm text-slate-500">{children}</div>;
}
