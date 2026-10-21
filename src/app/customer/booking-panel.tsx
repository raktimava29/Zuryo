"use client";

import LogoutButton from "@/app/components/logout-button";

import { useCallback, useEffect, useMemo, useState } from "react";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, callback: (event: { error?: { description?: string } }) => void) => void;
    };
  }
}

type ServiceZone = { id: string; name: string; timezone: string };
type Trainer = { trainer_id: string; full_name: string };
type PackageOption = { id: string; name: string; session_count: number; price_paise: number; validity_days: number };
type CustomerPackage = { id: string; catalog_id: string | null; sessions_purchased: number; sessions_remaining: number; expires_at: string | null };
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
  const [minDateTime, setMinDateTime] = useState(() => localDateTimeValue(new Date(Date.now() + 60_000)));
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [trainerId, setTrainerId] = useState("");
  const [booking, setBooking] = useState<Booking | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [catalog, setCatalog] = useState<PackageOption[]>([]);
  const [packages, setPackages] = useState<CustomerPackage[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState("");

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

  const refreshPackages = useCallback(async () => {
    const response = await fetch("/api/packages", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load packages.");
    setCatalog(body.catalog ?? []); setPackages(body.packages ?? []);
    if (body.packages?.[0]) setSelectedPackageId((current) => current || body.packages[0].id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      refreshPackages().catch((error: Error) => {
        if (!cancelled) setMessage(error.message);
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refreshPackages]);

  function loadRazorpay(): Promise<boolean> {
    return new Promise((resolve) => {
      if (window.Razorpay) { resolve(true); return; }
      const script = document.createElement("script"); script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve(true); script.onerror = () => resolve(false); document.body.appendChild(script);
    });
  }

  async function startRazorpayCheckout(bookingId: string) {
    setCheckoutBusy(true); setMessage("");
    try {
      const response = await fetch("/api/payments/razorpay/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookingId }) });
      const order = await response.json(); if (!response.ok) throw new Error(order.error ?? "Could not start payment.");
      if (!await loadRazorpay()) throw new Error("Razorpay checkout script could not load. Check network/ad blocker and retry.");
      const options = { key: order.keyId, amount: order.amount, currency: order.currency, name: "Zuryo", description: "60-minute training session", order_id: order.orderId,
        handler: async () => {
          setMessage("Payment submitted. Waiting for verified payment confirmation…");
          for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise((resolve) => window.setTimeout(resolve, 2000));
            try {
              const statusResponse = await fetch(`/api/payments/status?bookingId=${encodeURIComponent(bookingId)}`, { cache: "no-store" });
              const statusBody = await statusResponse.json();
              if (statusResponse.ok && statusBody.booking) {
                setBooking((current) => current ? { ...current, status: statusBody.booking.status } : current);
                if (statusBody.booking.status === "CONFIRMED") { setMessage("Payment verified. Booking confirmed."); return; }
                if (statusBody.booking.status === "PAYMENT_FAILED") { setMessage("Payment failed. Booking hold released."); return; }
              }
            } catch { /* Webhook remains source of truth; retry status check. */ }
          }
          setMessage("Payment submitted, but confirmation is still pending. Check again shortly; do not pay again until status resolves.");
        },
        modal: { ondismiss: () => setMessage("Checkout closed. Booking remains pending until payment confirmation or hold expiry.") },
        theme: { color: "#0f766e" } };
      const Razorpay = window.Razorpay; if (!Razorpay) throw new Error("Razorpay checkout unavailable.");
      const checkout = new Razorpay(options); checkout.on("payment.failed", (event: { error?: { description?: string } }) => setMessage(event.error?.description ?? "Payment failed. Booking remains pending until failure webhook or hold expiry.")); checkout.open();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Checkout failed."); } finally { setCheckoutBusy(false); }
  }

  async function buyPackage(catalogId: string) {
    const priorPackageIds = new Set(packages.map((pkg) => pkg.id));
    setCheckoutBusy(true); setMessage("");
    try {
      const response = await fetch("/api/packages/purchase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ catalogId }) });
      const order = await response.json(); if (!response.ok) throw new Error(order.error ?? "Could not start package purchase.");
      if (!await loadRazorpay()) throw new Error("Razorpay checkout script could not load.");
      const Razorpay = window.Razorpay; if (!Razorpay) throw new Error("Razorpay checkout unavailable.");
      const checkout = new Razorpay({ key: order.keyId, amount: order.amount, currency: order.currency, name: "Zuryo", description: `${order.package.name} package`, order_id: order.orderId, handler: async () => {
          setMessage("Package payment submitted. Waiting for verified payment confirmation…");
          for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise((resolve) => window.setTimeout(resolve, 2000));
            try {
              await refreshPackages();
              const balanceResponse = await fetch("/api/packages", { cache: "no-store" });
              const balanceBody = await balanceResponse.json();
              if (balanceResponse.ok && (balanceBody.packages ?? []).some((pkg: CustomerPackage) => pkg.catalog_id === catalogId && !priorPackageIds.has(pkg.id))) {
                setMessage("Package payment verified. Session credits added."); return;
              }
            } catch { /* Retry while webhook processing completes. */ }
          }
          setMessage("Payment submitted, but package credits have not appeared yet. Refresh balance shortly; do not purchase again until status resolves.");
        }, modal: { ondismiss: () => setMessage("Checkout closed. Package credits are added only after verified payment confirmation.") }, theme: { color: "#0f766e" } });
      checkout.on("payment.failed", (event: { error?: { description?: string } }) => setMessage(event.error?.description ?? "Package payment failed.")); checkout.open();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Package purchase failed."); } finally { setCheckoutBusy(false); }
  }

  async function redeemPackage() {
    if (!booking || !selectedPackageId) return;
    setCheckoutBusy(true); setMessage("");
    try { const response = await fetch("/api/packages/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookingId: booking.id, packageId: selectedPackageId }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Could not redeem package."); setBooking({ ...booking, status: "CONFIRMED" }); setMessage("Package credit applied. Booking confirmed."); await refreshPackages(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Package redemption failed."); } finally { setCheckoutBusy(false); }
  }

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
              onClick={() => { setMode(item); setTrainers([]); setTrainerId(""); setBooking(null); setStartsAt(localDateTimeValue(new Date(Date.now() + (item === "INSTANT" ? 15 : 24 * 60) * 60_000))); setMinDateTime(localDateTimeValue(new Date(Date.now() + (item === "INSTANT" ? 1 : 60) * 60_000))); }}
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
            {booking.status === "PENDING_PAYMENT" && <div className="mt-4 space-y-3"><button type="button" disabled={checkoutBusy} onClick={() => startRazorpayCheckout(booking.id)} className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{checkoutBusy ? "Opening checkout…" : `Pay with Razorpay · ${money(booking.total_paise)}`}</button>{packages.length > 0 && <div className="rounded-lg border border-teal-200 bg-white p-3"><label className="block text-sm font-medium text-slate-800">Or use package credit<select value={selectedPackageId} onChange={(e) => setSelectedPackageId(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 p-2">{packages.map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.sessions_remaining} sessions remaining{pkg.expires_at ? ` · expires ${new Date(pkg.expires_at).toLocaleDateString()}` : ""}</option>)}</select></label><button type="button" disabled={checkoutBusy || !selectedPackageId} onClick={redeemPackage} className="mt-3 rounded-lg border border-teal-700 px-4 py-2 text-sm font-semibold text-teal-800 disabled:opacity-50">Confirm using 1 session credit</button></div>}</div>}
          </div>}
          <div className="mt-6 border-t border-slate-200 pt-5"><div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold text-slate-950">Session packages</h2><button type="button" onClick={() => refreshPackages().catch((error: Error) => setMessage(error.message))} className="text-sm font-semibold text-teal-700">Refresh balances</button></div><p className="mt-1 text-sm text-slate-600">Credits appear only after Razorpay webhook confirms payment.</p>{packages.length > 0 && <p className="mt-3 text-sm font-medium text-slate-800">Your credits: {packages.reduce((sum, item) => sum + item.sessions_remaining, 0)} session(s)</p>}<div className="mt-3 grid gap-3 sm:grid-cols-2">{catalog.map((item) => <div key={item.id} className="rounded-xl border border-slate-200 p-4"><p className="font-semibold text-slate-950">{item.name}</p><p className="mt-1 text-sm text-slate-600">{item.session_count} sessions · valid {item.validity_days} days</p><p className="mt-2 text-lg font-bold text-slate-950">{money(item.price_paise)}</p><button type="button" disabled={checkoutBusy} onClick={() => buyPackage(item.id)} className="mt-3 w-full rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Buy package</button></div>)}</div>{catalog.length === 0 && <p className="mt-3 text-sm text-slate-500">No active packages. Add catalog entries in Supabase after applying migrations.</p>}</div>
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
