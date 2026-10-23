# Zuryo — Phase 3: Customer Booking UI

Stack: React + Vite + TypeScript + Tailwind CSS v4; Express + TypeScript; Supabase PostgreSQL.

## Install and run

From repository root:

```powershell
npm install
```

Copy `apps/backend/.env.example` to `apps/backend/.env`, then set `DATABASE_URL` from Supabase. For a fresh database, run `supabase/schema.sql` in Supabase SQL Editor. For your existing database, run `supabase/migrations/20261023_flexible_trainer_windows.sql` once to add daily trainer working windows (06:00–22:00 Asia/Kolkata) for the next 30 days. Existing hourly availability rows can remain; API checks full-window coverage and avoids duplicate trainer results.

```powershell
npm run dev
```

- Customer UI: http://localhost:5173
- API health: http://localhost:4000/api/health

Frontend API base URL defaults to `http://localhost:4000`. Override with `VITE_API_BASE_URL` in `apps/frontend/.env` if needed.

## Customer UI included

- Customer dashboard with booking flow
- Date, 15-minute start-time selection and service-zone selection
- Live trainer availability from backend
- Trainer selection
- Server-calculated normal/peak price preview and 10% commission breakdown
- Scheduled and instant booking modes
- Booking confirmation and booking history
- Booking cancellation with reason
- Loading, empty, success and error states
- Responsive layout for desktop and mobile

The seeded demo customer UUID is configured in `apps/frontend/src/main.tsx`. Replace it if your seeded database uses a different customer ID. This is demo-only identity selection, not authentication.

## API endpoints

- `GET /api/health` — API/database health
- `GET /api/pricing?startsAt=<ISO timestamp>` — server-calculated pricing preview
- `GET /api/availability?startsAt=<ISO timestamp>&serviceZone=ZONE-A` — eligible trainers for selected slot
- `GET /api/bookings?customerId=<uuid>` — customer booking history
- `GET /api/bookings?trainerId=<uuid>` — trainer assigned bookings
- `POST /api/bookings` — create instant or scheduled booking
- `PATCH /api/bookings/:id/cancel` — cancel booking

### Create booking request

```json
{
  "customerId": "UUID_FROM_USERS_TABLE",
  "mode": "SCHEDULED",
  "startsAt": "2026-10-25T10:00:00.000Z",
  "serviceZone": "ZONE-A",
  "preferredTrainerId": null,
  "idempotencyKey": "client-generated-unique-key"
}
```

Modes: `SCHEDULED` or `INSTANT`. Instant booking start must be between now and 60 minutes from now. Scheduled booking must start in the future. Sessions last 60 minutes. Pricing is selected on server: normal ₹399, peak ₹499, plus 10% commission. Current deterministic peak rule: local hour 17:00–20:59 in `Asia/Kolkata`; adjust in `apps/backend/src/config/pricing.ts`.

## Known limitations / next milestones

- Demo identity only; authentication and role-based authorization still need implementation before public deployment.
- Payment is simulated. Razorpay Test Mode integration remains a later milestone; no real payments are processed.
- Trainer dashboard, authoritative session start/55-minute warning/60-minute completion, package credits, fitness profile and working AI recommendation remain to be built.
- Automated tests for critical business logic and API flows remain planned for the testing milestone.
- Configure production CORS, secrets and hosting before deployment.

## Engineering notes

- Keep `DATABASE_URL` only in backend env. Never put it in a `VITE_*` variable.
- Booking creation uses a transaction and PostgreSQL advisory lock, plus database exclusion constraint to prevent overlapping confirmed/in-progress trainer sessions.
- Availability rows represent working windows. Demo trainer windows run 06:00–22:00 Asia/Kolkata for the next 30 days. UI offers 15-minute start increments from 06:00 through 21:00 local time; each booking lasts 60 minutes. Backend verifies the full requested interval fits inside a working window and does not overlap another confirmed/in-progress booking.
- Use synthetic data only. Do not expose this demo API publicly with real data before adding authentication and authorization.

## Authentication and role access

Run `supabase/migrations/20261023_authentication.sql` once after `supabase/schema.sql`.

- Public signup creates `CUSTOMER` accounts only.
- Login uses email + password; password hashes use bcrypt.
- Session uses an HTTP-only cookie. Set `JWT_SECRET` to a unique random secret, especially in production.
- Customer booking creation/history/cancellation routes require a customer session and enforce ownership.
- Trainer and operations accounts can log in, but their full dashboards are not implemented yet.
- CORS credentials are enabled for `FRONTEND_ORIGIN`; use HTTPS in production.

Seeded demo logins after migration:

| Role | Email | Password |
|---|---|---|
| Customer | `customer.demo@zuryo.local` | `CustomerDemo123!` |
| Trainer | `trainer.demo@zuryo.local` | `TrainerDemo123!` |
| Operations | `ops.demo@zuryo.local` | `OpsDemo123!` |

These are local demo credentials only. Change them before public deployment; never use them for real accounts. Demo password hashes are provisioned only when `password_hash` is null.

## Phase 7 — Trainer dashboard and session timer

Trainer accounts now have a protected trainer workspace at login. The dashboard calls `GET /api/trainer/sessions` and displays sessions assigned to the authenticated trainer only. It refreshes every 15 seconds. Customer booking history also refreshes every 15 seconds while customer workspace is open.

### Session lifecycle

- Trainer can start an assigned `CONFIRMED` session up to 15 minutes before scheduled start, and only before scheduled end.
- `POST /api/trainer/sessions/:id/start` records `session_started_at` using PostgreSQL `now()` and changes status to `IN_PROGRESS`.
- Timer derives from server-recorded `session_started_at`, not the device's chosen start time.
- UI shows 55-minute warning when five minutes remain.
- `GET /api/trainer/sessions` marks sessions `COMPLETED` after 60 minutes, even if browser was closed. Completion timestamp is derived from server-recorded start plus 60 minutes.
- `POST /api/trainer/sessions/:id/complete` rejects early completion; backend enforces full 60 minutes.
- Start/completion create customer notifications in `notifications` table. UI status refreshes by polling; this is not websocket push.
- Trainer endpoints require valid session and `TRAINER` role; queries scope data to authenticated trainer ID.

### Test trainer session flow

1. Log in as `trainer.demo@zuryo.local`.
2. Create a customer booking assigned to Demo Trainer with a start time within the next 15 minutes (and before its end), or use a suitable existing booking.
3. Trainer dashboard should show booking. Click **Start session**.
4. Confirm status becomes `IN_PROGRESS` and timer appears.
5. Verify `POST /api/trainer/sessions/:id/complete` before 60 minutes returns `409 SESSION_NOT_FINISHED`.
6. For fast development verification, do not manually edit production data. In local test database only, you may set `session_started_at = now() - interval '60 minutes'` for that booking, then refresh dashboard; backend should mark it `COMPLETED`.
7. Log in as customer and confirm booking status updates after refresh/polling.

Session timing is enforced by backend/database clock. The browser countdown is display-only. Polling interval is 15 seconds, so UI may reflect state up to roughly 15 seconds after backend transition.
