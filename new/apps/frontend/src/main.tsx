import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

type Trainer = { trainer_id: string; display_name: string; average_rating: number | null; starts_at: string; ends_at: string };
type Pricing = { currency: string; isPeak: boolean; sessionPrice: number; commissionRate: number; commissionAmount: number; totalAmount: number };
type Booking = {
  id: string; customer_id: string; trainer_id: string | null; mode: 'INSTANT' | 'SCHEDULED'; status: string;
  service_zone: string; starts_at: string; ends_at: string; session_price: string; commission_amount: string;
  total_amount: string; payment_status: string; cancellation_reason?: string | null; trainer_name?: string | null;
};
type ApiError = { error?: string; message?: string };

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
type SessionUser = { id: string; email: string; displayName: string; role: 'CUSTOMER' | 'TRAINER' | 'OPS' };

const money = (value: number | string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value));
const dateLabel = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', options).format(date);
const toLocalInput = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const toLocalDateTimeInput = (date: Date) => `${toLocalInput(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const fromLocalDateTimeInput = (value: string) => new Date(value);
const maxBookingDateTime = () => { const date = new Date(); date.setDate(date.getDate() + 30); date.setHours(22, 0, 0, 0); return toLocalDateTimeInput(date); };
const minBookingDateTime = () => { const date = new Date(); date.setSeconds(0, 0); date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15); return toLocalDateTimeInput(date); };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload as ApiError;
    throw new Error(error.message || error.error || `Request failed (${response.status})`);
  }
  return payload as T;
}

type TrainerSession = {
  id: string; customer_id: string; customer_name: string; trainer_id: string; status: string;
  starts_at: string; ends_at: string; session_started_at: string | null; session_completed_at: string | null;
  service_zone: string; total_amount: string;
};

function TrainerWorkspace({ user, onLogout }: { user: SessionUser; onLogout: () => Promise<void> }) {
  const [sessions, setSessions] = useState<TrainerSession[]>([]);
  const [serverNow, setServerNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      const result = await request<{ sessions: TrainerSession[]; serverNow: string }>('/api/trainer/sessions');
      setSessions(result.sessions);
      setServerNow(new Date(result.serverNow).getTime());
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load assigned sessions'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { setServerNow(v => v + 15000); void refresh(); }, 15000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function sessionAction(session: TrainerSession, action: 'start' | 'complete') {
    setBusyId(session.id); setError(''); setNotice('');
    try {
      await request(`/api/trainer/sessions/${session.id}/${action}`, { method: 'POST', body: '{}' });
      setNotice(action === 'start' ? 'Session started. Timer uses server-recorded start time.' : 'Session completed.');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Session update failed'); await refresh(); }
    finally { setBusyId(''); }
  }

  const active = sessions.filter(s => s.status === 'IN_PROGRESS');
  const upcoming = sessions.filter(s => s.status === 'CONFIRMED');
  const history = sessions.filter(s => ['COMPLETED', 'CANCELLED', 'NO_TRAINER'].includes(s.status));
  const fmt = (value: string) => dateLabel(new Date(value), { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const remaining = (session: TrainerSession) => Math.max(0, 3600 - Math.floor((serverNow - new Date(session.session_started_at!).getTime()) / 1000));
  const timer = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  return <div className="app-shell"><aside className="sidebar"><div className="brand-lockup"><span className="brand-mark">z</span><span className="brand-name">zuryo<span>FITNESS, TOGETHER</span></span></div><div className="sidebar-label">TRAINER WORKSPACE</div><div className="sidebar-bottom"><div className="avatar">{user.displayName.split(' ').map(x => x[0]).slice(0,2).join('').toUpperCase()}</div><div className="profile-label"><strong>{user.displayName}</strong><span>Trainer account</span></div><span className="online-dot" /></div></aside>
    <main className="main-content"><header className="topbar"><div><span className="eyebrow">COACH CONSOLE</span><h1>Your sessions.</h1></div><div className="topbar-right"><span className="status-pill"><span/> Live refresh · 15 sec</span><button className="logout-button" onClick={() => void onLogout()}>Log out</button></div></header>
    {error && <div className="notice error" role="alert"><span>!</span><p>{error}</p><button onClick={() => setError('')}>×</button></div>}{notice && <div className="notice success" role="status"><span>✓</span><p>{notice}</p><button onClick={() => setNotice('')}>×</button></div>}
    <div className="section-heading"><div><span className="eyebrow">YOUR COACHING DAY</span><h2>Assigned sessions</h2></div><button className="outline-button" onClick={() => void refresh()}>↻ Refresh</button></div>
    <div className="history-stats"><div className="stat-card"><span>IN PROGRESS</span><strong>{active.length}</strong><small>Active sessions</small></div><div className="stat-card"><span>UPCOMING</span><strong>{upcoming.length}</strong><small>Assigned sessions</small></div><div className="stat-card"><span>COMPLETED</span><strong>{history.length}</strong><small>Session history</small></div></div>
    {loading ? <div className="loading-state"><span className="spinner"/> Loading sessions…</div> : sessions.length === 0 ? <div className="empty-history"><div className="empty-icon">▤</div><h3>No assigned sessions yet</h3><p>New customer bookings will appear here automatically.</p></div> : <div className="booking-list">{sessions.map(session => { const seconds = session.session_started_at ? remaining(session) : 3600; const canStart = session.status === 'CONFIRMED' && new Date(session.starts_at).getTime() <= serverNow + 15 * 60 * 1000 && new Date(session.ends_at).getTime() > serverNow; return <article className="booking-row trainer-session-row" key={session.id}><div className="booking-date"><strong>{dateLabel(new Date(session.starts_at), { day: '2-digit' })}</strong><span>{dateLabel(new Date(session.starts_at), { month: 'short' }).toUpperCase()}</span></div><div className="booking-detail"><strong>{session.customer_name}</strong><span>{fmt(session.starts_at)} – {dateLabel(new Date(session.ends_at), { hour: 'numeric', minute: '2-digit' })}</span><small>{session.service_zone} · {session.id.slice(0, 8)}</small>{session.status === 'IN_PROGRESS' && <div className="session-timer"><strong>{timer(seconds)}</strong><span>{seconds <= 300 ? '55-minute warning reached' : 'Session in progress'}</span><div className="timer-track"><span style={{ width: `${Math.min(100, ((3600 - seconds) / 3600) * 100)}%` }}/></div></div>}</div><div className="booking-amount"><span className={`booking-status ${session.status.toLowerCase()}`}>{session.status.replace('_', ' ')}</span>{session.status === 'IN_PROGRESS' && <small>{seconds === 0 ? 'Finishing…' : `${Math.ceil(seconds / 60)} min left`}</small>}</div><div className="booking-actions">{canStart ? <button className="primary-button trainer-action" disabled={busyId === session.id} onClick={() => void sessionAction(session, 'start')}>{busyId === session.id ? 'Starting…' : 'Start session'}</button> : session.status === 'IN_PROGRESS' ? <button className="primary-button trainer-action" disabled={busyId === session.id || seconds > 0} onClick={() => void sessionAction(session, 'complete')}>{busyId === session.id ? 'Completing…' : seconds > 0 ? 'In progress' : 'Complete session'}</button> : <span className="muted-dash">—</span>}</div></article>})}</div>}
    <footer className="footer"><span>© 2026 ZURYO FITNESS</span><span>MOVE WELL. FEEL MORE.</span><span>SERVER-TIMED SESSIONS</span></footer></main></div>;
}

function App() {
  const [authUser, setAuthUser] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authName, setAuthName] = useState('');
  const [authEmail, setAuthEmail] = useState('customer.demo@zuryo.local');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(() => toLocalInput(new Date(Date.now() + 24 * 60 * 60 * 1000)));
  const [hour, setHour] = useState(() => { const initial = new Date(Date.now() + 24 * 60 * 60 * 1000); initial.setHours(10, 0, 0, 0); return initial.toISOString(); });
  const [zone, setZone] = useState('ZONE-A');
  const [mode, setMode] = useState<'SCHEDULED' | 'INSTANT'>('SCHEDULED');
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [selectedTrainer, setSelectedTrainer] = useState('');
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loadingAvailability, setLoadingAvailability] = useState(false);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState('');
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [tab, setTab] = useState<'book' | 'history'>('book');

  const startsAt = useMemo(() => new Date(hour), [hour]);
  const startsAtIso = startsAt.toISOString();
  const isFuture = startsAt.getTime() > Date.now();

  const loadAvailability = useCallback(async () => {
    setLoadingAvailability(true);
    setNotice(null);
    setTrainers([]);
    setSelectedTrainer('');
    setPricing(null);
    try {
      const [availability, price] = await Promise.all([
        request<{ trainers: Trainer[] }>(`/api/availability?startsAt=${encodeURIComponent(startsAt.toISOString())}&serviceZone=${encodeURIComponent(zone)}`),
        request<Pricing>(`/api/pricing?startsAt=${encodeURIComponent(startsAt.toISOString())}`),
      ]);
      setTrainers(availability.trainers);
      setPricing(price);
      if (availability.trainers.length) setSelectedTrainer(availability.trainers[0].trainer_id);
      else setNotice({ type: 'info', text: 'No trainer available for this slot. Try another time or service zone.' });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not load availability. Check backend connection.' });
    } finally { setLoadingAvailability(false); }
  }, [startsAtIso, zone]);

  const loadBookings = useCallback(async () => {
    setLoadingBookings(true);
    try {
      const result = await request<{ bookings: Booking[] }>(`/api/bookings?customerId=${encodeURIComponent(customerId)}`);
      setBookings(result.bookings);
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not load bookings.' });
    } finally { setLoadingBookings(false); }
  }, [customerId]);

  useEffect(() => { request<{ user: SessionUser }>('/api/auth/me').then(({ user }) => { setAuthUser(user); setCustomerId(user.id); }).catch(() => undefined).finally(() => setAuthChecked(true)); }, []);
  useEffect(() => { if (authUser?.role === 'CUSTOMER') void loadAvailability(); }, [authUser, loadAvailability]);
  useEffect(() => { if (authUser?.role !== 'CUSTOMER') return; void loadBookings(); const id = window.setInterval(() => { void loadBookings(); }, 15000); return () => window.clearInterval(id); }, [authUser, loadBookings]);

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault(); setAuthBusy(true); setAuthError('');
    try {
      const payload = authMode === 'signup'
        ? { displayName: authName, email: authEmail, password: authPassword }
        : { email: authEmail, password: authPassword };
      const result = await request<{ user: SessionUser }>(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify(payload) });
      setAuthUser(result.user); setCustomerId(result.user.id);
    } catch (error) { setAuthError(error instanceof Error ? error.message : 'Authentication failed'); }
    finally { setAuthBusy(false); }
  }
  async function logout() { await request('/api/auth/logout', { method: 'POST' }).catch(() => undefined); setAuthUser(null); setCustomerId(''); setBookings([]); setTrainers([]); setAuthPassword(''); }


  async function createBooking() {
    if (!isFuture) { setNotice({ type: 'error', text: 'Choose a future time slot.' }); return; }
    if (!selectedTrainer) { setNotice({ type: 'error', text: 'Select an available trainer first.' }); return; }
    setSubmitting(true); setNotice(null);
    try {
      const result = await request<{ booking: Booking; pricing?: Pricing; payment?: { status: string }; idempotentReplay?: boolean }>('/api/bookings', {
        method: 'POST', body: JSON.stringify({
          customerId, mode, startsAt: startsAt.toISOString(), serviceZone: zone,
          preferredTrainerId: selectedTrainer || null,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setNotice({ type: 'success', text: `${result.idempotentReplay ? 'Existing booking retrieved' : 'Session booked'} · ${result.booking.id}` });
      setTab('history');
      await loadBookings();
      await loadAvailability();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Booking failed. Try again.' });
      await loadAvailability();
    } finally { setSubmitting(false); }
  }

  async function cancelBooking(booking: Booking) {
    if (!window.confirm('Cancel this session?')) return;
    setCancelling(booking.id); setNotice(null);
    try {
      await request<{ booking: Booking }>(`/api/bookings/${booking.id}/cancel`, {
        method: 'PATCH', body: JSON.stringify({ customerId, reason: 'Cancelled by customer' }),
      });
      setNotice({ type: 'success', text: 'Booking cancelled successfully.' });
      await loadBookings();
      await loadAvailability();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Cancellation failed.' });
    } finally { setCancelling(''); }
  }

  const activeBookings = bookings.filter(b => ['CONFIRMED', 'IN_PROGRESS'].includes(b.status));
  const completedBookings = bookings.filter(b => ['COMPLETED', 'CANCELLED'].includes(b.status));

  if (!authChecked) return <div className="auth-screen"><div className="auth-card"><span className="brand-mark">z</span><h1>Loading Zuryo…</h1></div></div>;
  if (!authUser) return <div className="auth-screen"><form className="auth-card" onSubmit={submitAuth}><span className="brand-mark">z</span><span className="eyebrow">YOUR COMMUNITY. YOUR COACH.</span><h1>{authMode === 'login' ? 'Welcome back.' : 'Start moving.'}</h1><p>{authMode === 'login' ? 'Log in to manage your fitness sessions.' : 'Create your customer account.'}</p>{authMode === 'signup' && <label>Full name<input required minLength={2} value={authName} onChange={e => setAuthName(e.target.value)} placeholder="Your name" /></label>}<label>Email<input required type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@example.com" /></label><label>Password<input required type="password" minLength={authMode === 'signup' ? 10 : 1} value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder={authMode === 'signup' ? 'At least 10 characters' : 'Your password'} /></label>{authError && <p className="auth-error">{authError}</p>}<button className="primary-button" disabled={authBusy}>{authBusy ? 'Please wait…' : authMode === 'login' ? 'Log in' : 'Create account'} <span>↗</span></button><button type="button" className="auth-switch" onClick={() => { setAuthMode(authMode === 'login' ? 'signup' : 'login'); setAuthError(''); }}>{authMode === 'login' ? 'New to Zuryo? Create account' : 'Already registered? Log in'}</button><div className="demo-login"><strong>Demo access</strong><span>Customer: customer.demo@zuryo.local</span><span>Trainer: trainer.demo@zuryo.local</span><span>Operations: ops.demo@zuryo.local</span><small>Demo passwords listed in README. Change before public deployment.</small></div></form></div>;
  if (authUser.role === 'TRAINER') return <TrainerWorkspace user={authUser} onLogout={logout} />;
  if (authUser.role === 'OPS') return <div className="auth-screen"><div className="auth-card role-card"><span className="brand-mark">z</span><span className="eyebrow">OPERATIONS WORKSPACE</span><h1>Welcome, {authUser.displayName}.</h1><p>Operations dashboard remains next phase. Trainer sessions are now live.</p><button className="primary-button" onClick={() => void logout()}>Log out <span>↗</span></button></div></div>;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#top" aria-label="Zuryo home"><span className="brand-mark">z</span><span>zuryo<span className="brand-dot">.</span></span></a>
      <div className="side-label">YOUR SPACE</div>
      <button className={`nav-link ${tab === 'book' ? 'active' : ''}`} onClick={() => setTab('book')}><span className="nav-icon">＋</span> Book a session</button>
      <button className={`nav-link ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}><span className="nav-icon">▤</span> My bookings <span className="nav-count">{activeBookings.length}</span></button>
      <div className="sidebar-bottom"><div className="avatar">DC</div><div className="profile-label"><strong>{authUser.displayName}</strong><span>Customer account</span></div><span className="online-dot" /></div>
    </aside>

    <main className="main-content" id="top">
      <header className="topbar"><div><span className="eyebrow">YOUR COMMUNITY. YOUR COACH.</span><h1>{tab === 'book' ? 'Make time for you.' : 'Your sessions.'}</h1></div><div className="topbar-right"><span className="status-pill"><span /> Demo environment</span><button className="logout-button" onClick={() => void logout()}>Log out</button></div></header>
      {notice && <div className={`notice ${notice.type}`} role="status"><span>{notice.type === 'success' ? '✓' : notice.type === 'error' ? '!' : 'i'}</span><p>{notice.text}</p><button onClick={() => setNotice(null)} aria-label="Dismiss message">×</button></div>}

      {tab === 'book' ? <>
        <section className="welcome-card"><div className="welcome-copy"><span className="mini-label">YOUR NEXT GOOD HABIT</span><h2>Stronger days<br /><em>start here.</em></h2><p>Book a personal trainer for your community. Your hour, your pace, your goals.</p><button className="text-button" onClick={() => document.getElementById('booking-panel')?.scrollIntoView({ behavior: 'smooth' })}>Find your session <span>↓</span></button></div><div className="welcome-art" aria-hidden="true"><div className="sun-disc"/><div className="art-ring ring-one"/><div className="art-ring ring-two"/><div className="art-figure"><span className="figure-head"/><span className="figure-body"/><span className="figure-arm arm-left"/><span className="figure-arm arm-right"/><span className="figure-leg leg-left"/><span className="figure-leg leg-right"/></div><div className="art-caption">MOVE WELL<br />FEEL MORE</div><div className="art-spark">✳</div></div><div className="welcome-index">01 / 03</div></section>

        <div className="section-heading" id="booking-panel"><div><span className="eyebrow">LET'S GET MOVING</span><h2>Find your session</h2></div><span className="duration-chip">◷ &nbsp;60 min session</span></div>
        <section className="booking-layout">
          <div className="booking-form card-panel">
            <div className="step-heading"><span className="step-number">01</span><div><h3>Choose your time</h3><p>Choose any 15-minute start time. Sessions last 60 minutes.</p></div></div>
            <div className="field-row"><label className="field-label" htmlFor="session-datetime">DATE & START TIME</label><label className="field-label" htmlFor="session-zone">SERVICE ZONE</label></div>
            <div className="field-row"><input id="session-datetime" className="datetime-picker-input" type="datetime-local" step={900} min={minBookingDateTime()} max={maxBookingDateTime()} value={toLocalDateTimeInput(startsAt)} onChange={e => { if (!e.target.value) return; const next = fromLocalDateTimeInput(e.target.value); setDate(toLocalInput(next)); setHour(next.toISOString()); setMode('SCHEDULED'); }} /><select id="session-zone" value={zone} onChange={e => setZone(e.target.value)}><option value="ZONE-A">Zone A · Main community</option><option value="ZONE-B">Zone B · Nearby community</option></select></div>
            <p className="datetime-help">Choose date and time in calendar popup. Minute steps: 00, 15, 30, 45. Session ends 60 minutes after start.</p>
            <div className="field-divider" />
            <div className="step-heading"><span className="step-number">02</span><div><h3>Choose your coach</h3><p>We match you with available trainers.</p></div></div>
            <div className="trainer-list">
              {loadingAvailability ? <div className="loading-state"><span className="spinner"/> Checking availability...</div> : trainers.length ? trainers.map((trainer, index) => <button key={trainer.trainer_id} className={`trainer-option ${selectedTrainer === trainer.trainer_id ? 'chosen' : ''}`} onClick={() => setSelectedTrainer(trainer.trainer_id)}><span className={`trainer-avatar tone-${index % 3}`}>{trainer.display_name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase()}</span><span className="trainer-info"><strong>{trainer.display_name}</strong><small>{trainer.average_rating ? `★ ${Number(trainer.average_rating).toFixed(1)} · ` : ''}Available for this slot</small></span><span className={`radio-dot ${selectedTrainer === trainer.trainer_id ? 'checked' : ''}`}>{selectedTrainer === trainer.trainer_id ? '✓' : ''}</span></button>) : <div className="empty-inline"><strong>No coaches found for this time.</strong><span>Try another start time or service zone.</span></div>}
            </div>
            <div className="field-divider" />
            <div className="step-heading"><span className="step-number">03</span><div><h3>Session type</h3><p>Choose how soon you want to start.</p></div></div>
            <div className="mode-options"><button className={mode === 'SCHEDULED' ? 'mode-option chosen' : 'mode-option'} onClick={() => setMode('SCHEDULED')}><span className="mode-symbol">▦</span><span><strong>Schedule ahead</strong><small>Book a future slot</small></span><span className="radio-dot">{mode === 'SCHEDULED' ? '✓' : ''}</span></button><button className={mode === 'INSTANT' ? 'mode-option chosen' : 'mode-option'} onClick={() => { const next = new Date(Math.ceil((Date.now() + 60 * 1000) / (15 * 60 * 1000)) * 15 * 60 * 1000); setDate(toLocalInput(next)); setHour(next.toISOString()); setMode('INSTANT'); }}><span className="mode-symbol">↗</span><span><strong>Instant session</strong><small>Start within 60 minutes</small></span><span className="radio-dot">{mode === 'INSTANT' ? '✓' : ''}</span></button></div>
          </div>

          <aside className="checkout-column"><div className="price-card"><div className="price-card-top"><span className="mini-label">YOUR SESSION</span><span className={`peak-badge ${pricing?.isPeak ? 'peak' : ''}`}>{pricing?.isPeak ? 'PEAK HOUR' : 'STANDARD RATE'}</span></div><div className="price-title">Personal training<span>60-minute one-on-one</span></div><div className="price-main">{pricing ? money(pricing.sessionPrice) : '—'}<span> / session</span></div><div className="price-divider"/><div className="price-line"><span>Session price</span><strong>{pricing ? money(pricing.sessionPrice) : '—'}</strong></div><div className="price-line"><span>Society commission <small>10%</small></span><strong>{pricing ? money(pricing.commissionAmount) : '—'}</strong></div><div className="price-divider"/><div className="price-line total"><span>Total payable</span><strong>{pricing ? money(pricing.totalAmount) : '—'}</strong></div><p className="price-note">Final price calculated securely by Zuryo.</p><button className="primary-button" disabled={submitting || loadingAvailability || !selectedTrainer || !pricing || !isFuture} onClick={() => void createBooking()}>{submitting ? 'Confirming...' : 'Confirm booking'} <span>↗</span></button><div className="secure-note"><span>✓</span> Demo checkout · no real payment charged</div></div><div className="info-card"><span className="info-icon">✳</span><div><strong>Built around you</strong><p>Every session is matched to trainer availability in your community.</p></div></div><div className="peak-note"><span className="peak-dot"/><p><strong>Peak hours</strong> · 5:00 PM–8:59 PM IST. Peak rate applies automatically.</p></div></aside>
        </section>
      </> : <section className="history-section"><div className="section-heading history-heading"><div><span className="eyebrow">YOUR FITNESS JOURNEY</span><h2>My bookings</h2></div><button className="outline-button" onClick={() => void loadBookings()}>↻ Refresh</button></div><div className="history-stats"><div className="stat-card"><span>UPCOMING</span><strong>{activeBookings.length}</strong><small>Confirmed sessions</small></div><div className="stat-card"><span>COMPLETED / CANCELLED</span><strong>{completedBookings.length}</strong><small>Past activity</small></div><div className="stat-card"><span>YOUR COMMUNITY</span><strong>Zone A</strong><small>Local trainer network</small></div></div>{loadingBookings ? <div className="loading-state"><span className="spinner"/> Loading bookings...</div> : bookings.length ? <div className="booking-list">{bookings.map(booking => <article className="booking-row" key={booking.id}><div className="booking-date"><strong>{dateLabel(new Date(booking.starts_at), { day: '2-digit' })}</strong><span>{dateLabel(new Date(booking.starts_at), { month: 'short' }).toUpperCase()}</span></div><div className="booking-detail"><strong>Personal training session</strong><span>{dateLabel(new Date(booking.starts_at), { weekday: 'short', hour: 'numeric', minute: '2-digit' })} – {dateLabel(new Date(booking.ends_at), { hour: 'numeric', minute: '2-digit' })}</span><small>{booking.trainer_name || 'Assigned trainer'} · {booking.service_zone}</small></div><div className="booking-amount"><strong>{money(booking.total_amount)}</strong><span className={`booking-status ${booking.status.toLowerCase()}`}>{booking.status.replace('_', ' ')}</span></div><div className="booking-actions">{booking.status === 'CONFIRMED' && new Date(booking.starts_at).getTime() > Date.now() ? <button className="cancel-button" disabled={cancelling === booking.id} onClick={() => void cancelBooking(booking)}>{cancelling === booking.id ? 'Cancelling…' : 'Cancel'}</button> : <span className="muted-dash">—</span>}</div></article>)}</div> : <div className="empty-history"><div className="empty-icon">▤</div><h3>No bookings yet</h3><p>Your next session starts with one small step.</p><button className="primary-button" onClick={() => setTab('book')}>Find a session <span>↗</span></button></div>}</section>}
      <footer className="footer"><span>© 2026 ZURYO FITNESS</span><span>MOVE WELL. FEEL MORE.</span><span>DEMO BUILD · SYNTHETIC DATA</span></footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
