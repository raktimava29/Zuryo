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
