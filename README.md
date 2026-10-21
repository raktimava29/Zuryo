# Zuryo

On-demand fitness booking MVP built with Next.js, TypeScript, Supabase Auth/Postgres, and SQL RPCs.

## Current booking flow

- Customer signs in and opens `/customer`.
- Selects service zone, instant booking (next 60 minutes) or scheduled booking (at least 60 minutes ahead), and start time.
- Availability API calls a role-checked database function. Database filters trainers by zone, active availability, and overlapping bookings.
- Customer selects an available trainer and submits booking request.
- `create_booking` calculates price and commission on the server, creates a `PENDING_PAYMENT` booking, session record, and trainer notification.
- `/api/checkout` runs simulated success/failure against the server-stored booking total. It never accepts a client-supplied amount.
- Unpaid holds expire after 10 minutes when booking/availability/checkout APIs run. Expired bookings become `PAYMENT_FAILED`, releasing trainer slot.
- Price shown in UI is an estimate. Stored database amount is authoritative.

Peak pricing currently assumes service-zone local time windows 06:00–09:00 and 17:00–21:00. Confirm this assumption with product owner before production.

## Environment

Create `.env.local` with:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
```

Never expose Supabase service-role keys in browser code.

## Database setup

Apply migrations in order in Supabase SQL Editor:

1. `supabase/migrations/initial_schema.sql`
2. `supabase/migrations/booking_engine.sql`
3. `supabase/migrations/secure_availability.sql`
4. `supabase/migrations/scheduled_availability.sql`
5. `supabase/migrations/phase2_checkout_and_expiry.sql`

Seed or configure authenticated demo accounts and trainer availability. Do not use real customer information.

## Local development

```bash
npm ci
npm run dev
```

Run checks:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

## Current limitations

- Checkout is simulated only; no real payment provider or funds are involved.
- Unpaid booking holds expire after 10 minutes when booking or availability APIs are used. For production, run expiry on a scheduled server-side job too.
- Booking API returns HTTP 200 for an already-existing idempotency key and HTTP 201 for a new booking. Database unique constraint/RPC protect duplicate creation under concurrent requests.
- Scheduled availability query is implemented by `get_available_trainers_for_slot`; database migration must be applied before using it.
- Session lifecycle/timer, packages, fitness assessment UI, recommendations, trainer/admin workflows, deployment, and end-to-end tests remain incomplete.
- Availability can change between lookup and booking. Booking RPC and database exclusion constraint are final conflict guards.
