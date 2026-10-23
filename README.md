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
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key # server-only; must be service-role key
NEXT_PUBLIC_RAZORPAY_KEY_ID=your_razorpay_test_key_id
RAZORPAY_KEY_ID=your_razorpay_test_key_id
RAZORPAY_KEY_SECRET=your_razorpay_test_key_secret
RAZORPAY_WEBHOOK_SECRET=your_razorpay_webhook_secret
```

Never expose Supabase service-role keys in browser code. If your existing variable is named `SUPABASE_KEY`, it must contain service-role credentials for webhook processing; anon/publishable keys will fail. `SUPABASE_KEY` is accepted as an alias only when it is a server-only service-role key compatible with your Supabase project. `RAZORPAY_KEY` and `RAZORPAY_SECRET` are accepted as server-side aliases. Set `RAZORPAY_WEBHOOK_SECRET` separately. `ENABLE_SIMULATED_CHECKOUT=true` is for local non-production demo only.

## Database setup

Apply migrations in order in Supabase SQL Editor:

1. `supabase/migrations/initial_schema.sql`
2. `supabase/migrations/booking_engine.sql`
3. `supabase/migrations/secure_availability.sql`
4. `supabase/migrations/scheduled_availability.sql`
5. `supabase/migrations/checkout_and_expiry.sql`
6. `supabase/migrations/session_lifecycle.sql`
7. `supabase/migrations/payments_packages.sql`
8. `supabase/migrations/phase3_completion.sql`
9. `supabase/migrations/phase3_finalization.sql`

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

- Customer checkout now uses Razorpay Checkout; verified webhooks are authoritative for payment state. Keep `/api/checkout` for local/demo-only testing and do not expose it as a production payment option.
- Package purchase and redemption endpoints require all Phase 3 migrations. Package credits are added only after verified captured-payment webhook. Configure a webhook URL pointing to `/api/payments/razorpay/webhook` with `payment.captured`, `payment.failed`, and `refund.processed` events.
- Package-credit restoration RPC is admin-only; restores one consumed credit only after its booking is `CANCELLED`, only once, and only while package remains unexpired.
- Full refunds are reconciled only after Razorpay sends a signature-verified `refund.processed` webhook. Configure this event alongside `payment.captured` and `payment.failed`. Refund rows are idempotent by provider refund ID and webhook event ID.
- Phase 3 supports full-refund reconciliation. Partial refunds are recorded, but payment remains `SUCCEEDED` until cumulative processed refunds equal original payment amount. Do not initiate partial refunds in the MVP.
- A full package refund revokes remaining package credits and writes a `REFUND` ledger entry. Previously consumed credits are not restored. A booking payment refund should follow booking cancellation; webhook reports `booking_reconciliation_required` if provider refund arrives while booking is not cancelled.
- Package catalog is not seeded automatically; insert reviewed package rows into `public.package_catalog` before selling packages.
- Unpaid booking holds expire after 10 minutes when booking or availability APIs are used. For production, run expiry on a scheduled server-side job too.
- Booking API returns HTTP 200 for an already-existing idempotency key and HTTP 201 for a new booking. Database unique constraint/RPC protect duplicate creation under concurrent requests.
- Scheduled availability query is implemented by `get_available_trainers_for_slot`; database migration must be applied before using it.
- Fitness assessment UI, recommendations, trainer/admin workflows, deployment, and end-to-end tests remain incomplete.
- Availability can change between lookup and booking. Booking RPC and database exclusion constraint are final conflict guards.

See [`PHASE3_RELEASE_CHECKLIST.md`](./PHASE3_RELEASE_CHECKLIST.md) for deployment steps, refund policy, sandbox acceptance checks, and verification SQL.

See [`PHASE3_RELEASE_CHECKLIST.md`](./PHASE3_RELEASE_CHECKLIST.md) for deployment steps, refund policy, sandbox acceptance checks, and verification SQL.
