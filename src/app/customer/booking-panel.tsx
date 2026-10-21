"use client";

import LogoutButton from "@/app/components/logout-button";

import { useEffect, useMemo, useState } from "react";

type ServiceZone = { id: string; name: string; timezone: string };
type Trainer = { trainer_id: string; full_name: string };
type Booking = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  slot_type: "NORMAL" | "PEAK";
  base_price_paise: number;
  commission_paise: number;
  total_paise: number;
  trainer_id: string;
};

const money = (paise: number) => new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", minimumFractionDigits: 2,
}).format(paise / 100);

function localDateTimeValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function BookingPanel({ customerName }: { customerName: string }) {
  const [zones, setZones] = useState<ServiceZone[]>([]);
  const [zoneId, setZoneId] = useState("");
  const [mode, setMode] = useState<"INSTANT" | "SCHEDULED">("INSTANT");
  const [startsAt, setStartsAt] = useState(() => localDateTimeValue(new Date(Date.now() + 15 * 60_000)));
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [trainerId, setTrainerId] = useState("");
  const [booking, setBooking] = useState<Booking | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);

  useEffect(() => {
    fetch("/api/service-zones")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load service zones.");
        setZones(body.serviceZones ?? []);
        if (body.serviceZones?.[0]) setZoneId(body.serviceZones[0].id);
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  const price = useMemo(() => {
    const hour = new Date(startsAt).getHours();
    const peak = (hour >= 6 && hour < 9) || (hour >= 17 && hour < 21);
    const base = peak ? 49900 : 39900;
    return { peak, base, commission: Math.round(base * 0.1), total: Math.round(base * 1.1) };
  }, [startsAt]);

  async function findTrainers() {
    setBusy(true); setMessage(""); setBooking(null); setTrainers([]); setTrainerId("");
    try {
      const query = new URLSearchParams({ serviceZoneId: zoneId, startsAt: new Date(startsAt).toISOString(), mode });
      const response = await fetch(`/api/availability?${query}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not retrieve availability.");
      setTrainers(body.trainers ?? []);
      if (!body.trainers?.length) setMessage("No trainers available for this time. Try another slot.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Availability request failed.");
    } finally { setBusy(false); }
  }

  async function createBooking() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startsAt: new Date(startsAt).toISOString(), serviceZoneId: zoneId, mode,
          idempotencyKey: crypto.randomUUID(), preferredTrainerId: trainerId || null,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Booking could not be created.");
      setBooking(body.booking as Booking);
      setMessage("Booking created. Complete checkout to confirm your session.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Booking request failed.");
    } finally { setBusy(false); }
  }

  async function checkout(outcome: "SUCCESS" | "FAILURE") {
    if (!booking) return;
    setCheckoutBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId: booking.id,
          idempotencyKey: crypto.randomUUID(),
          outcome,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Checkout failed.");
      setBooking(body.booking as Booking);
      setMessage(body.paymentStatus === "SUCCEEDED"
        ? "Simulated payment successful. Booking confirmed."
        : body.paymentStatus === "FAILED"
          ? "Simulated payment failed. Slot released."
          : "Payment state unchanged.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Checkout failed.");
    } finally {
      setCheckoutBusy(false);
    }
  }

  const minDateTime = localDateTimeValue(new Date(Date.now() + (mode === "INSTANT" ? 1 : 60) * 60_000));

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10 sm:px-8">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-sm font-semibold uppercase tracking-[0.2em] text-teal-700">Zuryo / Customer</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Hey, {customerName}</h1>
          <p className="mt-2 text-slate-600">Book your next 60-minute workout.</p></div>
        <span className="rounded-full bg-teal-50 px-4 py-2 text-sm font-semibold text-teal-800">60 min session</span>
        <LogoutButton />
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-950">Find a trainer</h2>
          <p className="mt-1 text-sm text-slate-600">Availability is checked by server against trainer schedules and active bookings.</p>
          <div className="mt-6 flex gap-2 rounded-xl bg-slate-100 p-1">
            {(["INSTANT", "SCHEDULED"] as const).map((item) => <button key={item} type="button"
              onClick={() => { setMode(item); setTrainers([]); setTrainerId(""); setBooking(null); setStartsAt(localDateTimeValue(new Date(Date.now() + (item === "INSTANT" ? 15 : 24 * 60) * 60_000))); }}
              className={`flex-1 rounded-lg px-4 py-3 text-sm font-semibold transition ${mode === item ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-950"}`}>
              {item === "INSTANT" ? "Instant · next hour" : "Schedule ahead"}</button>)}
          </div>
          <label className="mt-5 block text-sm font-medium text-slate-700">Service zone
            <select value={zoneId} onChange={(e) => { setZoneId(e.target.value); setTrainers([]); }} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 outline-none focus:border-teal-600" required>
              {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
            </select>
          </label>
          <label className="mt-4 block text-sm font-medium text-slate-700">Start time
            <input type="datetime-local" value={startsAt} min={minDateTime} onChange={(e) => { setStartsAt(e.target.value); setTrainers([]); setTrainerId(""); setBooking(null); }}
              className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-teal-600" required />
          </label>
          <button type="button" disabled={busy || !zoneId || !startsAt} onClick={findTrainers}
            className="mt-5 w-full rounded-xl bg-slate-950 px-4 py-3 font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? "Checking…" : "Check availability"}</button>

          {trainers.length > 0 && <div className="mt-6 border-t border-slate-200 pt-5"><h3 className="font-semibold text-slate-900">Available trainers</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">{trainers.map((trainer) => <button key={trainer.trainer_id} type="button" onClick={() => setTrainerId(trainer.trainer_id)}
              className={`rounded-xl border p-4 text-left ${trainerId === trainer.trainer_id ? "border-teal-600 bg-teal-50 ring-1 ring-teal-600" : "border-slate-200 hover:border-slate-400"}`}>
              <span className="block font-semibold text-slate-950">{trainer.full_name}</span><span className="mt-1 block text-sm text-slate-600">{trainerId === trainer.trainer_id ? "Selected trainer" : "Select trainer"}</span></button>)}</div>
            <button type="button" disabled={busy || !trainerId} onClick={createBooking} className="mt-4 w-full rounded-xl bg-teal-700 px-4 py-3 font-semibold text-white hover:bg-teal-800 disabled:opacity-50">{busy ? "Creating booking…" : "Reserve this trainer"}</button>
          </div>}
          {message && <p role="status" className="mt-4 rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-700">{message}</p>}
          {booking && <div className="mt-5 rounded-xl border border-teal-200 bg-teal-50 p-4"><p className="font-semibold text-teal-950">Booking reference</p><p className="mt-1 break-all text-sm text-teal-900">{booking.id}</p><p className="mt-1 text-sm text-teal-900">Status: {booking.status.replaceAll("_", " ")}</p>
            {booking.status === "PENDING_PAYMENT" && <div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={checkoutBusy} onClick={() => checkout("SUCCESS")} className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{checkoutBusy ? "Processing…" : `Simulate payment · ${money(booking.total_paise)}`}</button><button type="button" disabled={checkoutBusy} onClick={() => checkout("FAILURE")} className="rounded-lg border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-800 disabled:opacity-50">Simulate failure</button></div>}
          </div>}
        </section>

        <aside className="h-fit rounded-2xl bg-slate-950 p-6 text-white shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-300">Estimated price</p>
          <h2 className="mt-3 text-3xl font-bold">{money(price.total)}</h2>
          <p className="mt-1 text-sm text-slate-300">60-minute session · {price.peak ? "Peak" : "Normal"} slot</p>
          <div className="my-6 border-t border-white/15" />
          <div className="space-y-3 text-sm"><div className="flex justify-between gap-4"><span className="text-slate-300">Session price</span><span>{money(price.base)}</span></div>
            <div className="flex justify-between gap-4"><span className="text-slate-300">Society commission (10%)</span><span>{money(price.commission)}</span></div>
            <div className="flex justify-between gap-4 border-t border-white/15 pt-3 text-base font-semibold"><span>Total payable</span><span>{money(price.total)}</span></div></div>
          <p className="mt-5 text-xs leading-5 text-slate-400">Peak windows shown using service-zone local time: 06:00–09:00 and 17:00–21:00. Final amount is calculated and stored by server; this panel is estimate only.</p>
        </aside>
      </div>
    </main>
  );
}
