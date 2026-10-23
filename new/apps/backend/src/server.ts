import 'dotenv/config';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Pool, type PoolClient } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { calculatePrice } from './config/pricing.js';

const app = express();
const port = Number(process.env.PORT ?? 4000);
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '1mb' }));

function requireDb(_req: Request, res: Response, next: NextFunction) {
  if (!pool) {
    res.status(503).json({ error: 'DATABASE_NOT_CONFIGURED', message: 'Set DATABASE_URL in apps/backend/.env' });
    return;
  }
  next();
}
app.use('/api', requireDb);

const JWT_SECRET = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production' && !JWT_SECRET) {
  throw new Error('JWT_SECRET is required in production');
}
const jwtSecret = JWT_SECRET || 'development-only-change-this-secret-before-deploying';
type AuthUser = { id: string; email: string; displayName: string; role: 'CUSTOMER' | 'TRAINER' | 'OPS' };
type AuthRequest = Request & { authUser?: AuthUser };
const cookieName = 'zuryo_session';
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 };
function setSession(res: Response, user: AuthUser) {
  const token = jwt.sign(user, jwtSecret, { expiresIn: '7d', issuer: 'zuryo-api' });
  res.cookie(cookieName, token, cookieOptions);
}
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!token) { res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Log in to continue' }); return; }
  try {
    (req as AuthRequest).authUser = jwt.verify(decodeURIComponent(token), jwtSecret, { issuer: 'zuryo-api' }) as unknown as AuthUser;
    next();
  } catch { res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined }); res.status(401).json({ error: 'INVALID_SESSION', message: 'Session expired. Log in again.' }); }
}
function requireRole(...roles: AuthUser['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthRequest).authUser;
    if (!user || !roles.includes(user.role)) { res.status(403).json({ error: 'FORBIDDEN', message: 'Your account cannot access this resource' }); return; }
    next();
  };
}
app.post('/api/auth/signup', async (req, res, next) => {
  const parsed = z.object({ displayName: z.string().trim().min(2).max(80), email: z.string().trim().email().max(254), password: z.string().min(10).max(72) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_SIGNUP', details: parsed.error.flatten() }); return; }
  const client = await pool!.connect();
  try {
    await client.query('begin');
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const result = await client.query(`insert into users(email, display_name, role, is_demo, password_hash) values(lower($1), $2, 'CUSTOMER', false, $3) returning id, email, display_name, role`, [parsed.data.email, parsed.data.displayName, passwordHash]);
    const user = result.rows[0];
    await client.query('insert into customer_profiles(user_id) values($1)', [user.id]);
    await client.query('commit');
    const sessionUser: AuthUser = { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
    setSession(res, sessionUser); res.status(201).json({ user: sessionUser });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') { res.status(409).json({ error: 'EMAIL_EXISTS', message: 'Account already exists for this email' }); return; }
    next(error);
  } finally { client.release(); }
});
app.post('/api/auth/login', async (req, res, next) => {
  const parsed = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(72) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_LOGIN', details: parsed.error.flatten() }); return; }
  try {
    const result = await pool!.query(`select id, email, display_name, role, password_hash from users where email = lower($1)`, [parsed.data.email]);
    const row = result.rows[0];
    if (!row?.password_hash || !(await bcrypt.compare(parsed.data.password, row.password_hash))) { res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email or password incorrect' }); return; }
    const user: AuthUser = { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
    setSession(res, user); res.json({ user });
  } catch (error) { next(error); }
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: (req as AuthRequest).authUser }));
app.post('/api/auth/logout', (_req, res) => { res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined }); res.json({ ok: true }); });

app.get('/api/health', async (_req, res) => {
  try {
    await pool!.query('select 1');
    res.json({ status: 'ok', service: 'zuryo-api', database: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', service: 'zuryo-api', database: 'error' });
  }
});

const timestampSchema = z.string().datetime({ offset: true });
app.get('/api/pricing', (req, res) => {
  const parsed = timestampSchema.safeParse(req.query.startsAt);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_START_TIME', message: 'startsAt must be ISO timestamp with timezone offset' });
    return;
  }
  res.json(calculatePrice(new Date(parsed.data)));
});

app.get('/api/availability', async (req, res, next) => {
  try {
    const parsed = z.object({
      startsAt: timestampSchema,
      serviceZone: z.string().trim().min(1).max(80).default('ZONE-A'),
    }).safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_QUERY', details: parsed.error.flatten() });
      return;
    }
    const startsAt = new Date(parsed.data.startsAt);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const result = await pool!.query(
      `select tp.user_id as trainer_id, u.display_name, tp.average_rating, $2::timestamptz as starts_at, $3::timestamptz as ends_at
       from trainer_profiles tp
       join users u on u.id = tp.user_id and u.role = 'TRAINER'
       where tp.is_active = true
         and $1 = any(tp.service_zones)
         and exists (
           select 1 from trainer_availability ta
           where ta.trainer_id = tp.user_id and ta.is_available = true
             and ta.starts_at <= $2 and ta.ends_at >= $3
         )
         and not exists (
           select 1 from bookings b
           where b.trainer_id = tp.user_id
             and b.status in ('CONFIRMED', 'IN_PROGRESS')
             and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
         )
       order by tp.average_rating desc nulls last, u.display_name asc`,
      [parsed.data.serviceZone, startsAt.toISOString(), endsAt.toISOString()],
    );
    res.json({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), trainers: result.rows });
  } catch (error) { next(error); }
});

const createBookingSchema = z.object({
  customerId: z.string().uuid(),
  mode: z.enum(['INSTANT', 'SCHEDULED']),
  startsAt: timestampSchema,
  serviceZone: z.string().trim().min(1).max(80),
  preferredTrainerId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(120),
});

app.post('/api/bookings', requireAuth, requireRole('CUSTOMER'), async (req, res, next) => {
  const authUser = (req as AuthRequest).authUser!;
  const parsed = createBookingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_BOOKING', details: parsed.error.flatten() });
    return;
  }

  const input = parsed.data;
  if (input.customerId !== authUser.id) { res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot create booking for another customer' }); return; }
  const startsAt = new Date(input.startsAt);
  const now = Date.now();
  if (input.mode === 'INSTANT' && (startsAt.getTime() < now || startsAt.getTime() > now + 60 * 60 * 1000)) {
    res.status(400).json({ error: 'INVALID_INSTANT_START', message: 'Instant booking must start between now and 60 minutes from now' });
    return;
  }
  if (input.mode === 'SCHEDULED' && startsAt.getTime() <= now) {
    res.status(400).json({ error: 'START_MUST_BE_FUTURE', message: 'Scheduled booking must start in the future' });
    return;
  }
  if (startsAt.getUTCSeconds() !== 0 || startsAt.getUTCMilliseconds() !== 0) {
    res.status(400).json({ error: 'START_MUST_ALIGN_TO_MINUTE', message: 'Session start must be aligned to a minute boundary' });
    return;
  }

  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  const pricing = calculatePrice(startsAt);
  let client: PoolClient | undefined;

  try {
    client = await pool!.connect();
    await client.query('begin');
    // Serialize booking writes so concurrent requests cannot select same trainer slot.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`${input.serviceZone}:${startsAt.toISOString()}`]);

    const existing = await client.query(
      'select * from bookings where customer_id = $1 and idempotency_key = $2',
      [input.customerId, input.idempotencyKey],
    );
    if (existing.rowCount) {
      await client.query('commit');
      res.status(200).json({ booking: existing.rows[0], idempotentReplay: true });
      return;
    }

    const customer = await client.query(
      `select cp.user_id from customer_profiles cp
       join users u on u.id = cp.user_id
       where cp.user_id = $1 and u.role = 'CUSTOMER'`,
      [input.customerId],
    );
    if (!customer.rowCount) {
      await client.query('rollback');
      res.status(404).json({ error: 'CUSTOMER_NOT_FOUND' });
      return;
    }

    const eligible = await client.query(
      `select tp.user_id as trainer_id
       from trainer_profiles tp
       where tp.is_active = true
         and $1 = any(tp.service_zones)
         and exists (
           select 1 from trainer_availability ta
           where ta.trainer_id = tp.user_id and ta.is_available = true
             and ta.starts_at <= $2 and ta.ends_at >= $3
         )
         and ($4::uuid is null or tp.user_id = $4::uuid)
         and not exists (
           select 1 from bookings b
           where b.trainer_id = tp.user_id
             and b.status in ('CONFIRMED', 'IN_PROGRESS')
             and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
         )
       order by case when tp.user_id = $4::uuid then 0 else 1 end,
                tp.average_rating desc nulls last, tp.user_id
       for update of tp`,
      [input.serviceZone, startsAt.toISOString(), endsAt.toISOString(), input.preferredTrainerId ?? null],
    );

    if (!eligible.rowCount) {
      await client.query('rollback');
      res.status(409).json({ error: 'NO_TRAINER_AVAILABLE', message: 'No eligible trainer available for selected slot and service zone' });
      return;
    }

    const trainerId = eligible.rows[0].trainer_id as string;
    const insert = await client.query(
      `insert into bookings
       (customer_id, trainer_id, mode, status, service_zone, starts_at, ends_at,
        session_price, commission_rate, commission_amount, total_amount, payment_status, idempotency_key)
       values ($1, $2, $3, 'CONFIRMED', $4, $5, $6, $7, $8, $9, $10, 'SIMULATED_PAID', $11)
       returning *`,
      [input.customerId, trainerId, input.mode, input.serviceZone, startsAt.toISOString(), endsAt.toISOString(),
       pricing.sessionPrice, pricing.commissionRate, pricing.commissionAmount, pricing.totalAmount, input.idempotencyKey],
    );
    const booking = insert.rows[0];

    await client.query(
      `insert into notifications (recipient_id, booking_id, event_type, message)
       values ($1, $2, 'BOOKING_ASSIGNED', 'A new fitness session has been assigned to you')`,
      [trainerId, booking.id],
    );
    await client.query('commit');
    res.status(201).json({ booking, pricing, payment: { status: 'SIMULATED_PAID' } });
  } catch (error: unknown) {
    if (client) await client.query('rollback').catch(() => undefined);
    const pgError = error as { code?: string };
    if (pgError.code === '23P01') {
      res.status(409).json({ error: 'TRAINER_SLOT_CONFLICT', message: 'Trainer was booked concurrently; choose another slot' });
      return;
    }
    if (pgError.code === '23503') {
      res.status(400).json({ error: 'INVALID_REFERENCE', message: 'Customer or trainer reference does not exist' });
      return;
    }
    next(error);
  } finally {
    client?.release();
  }
});

app.get('/api/bookings', requireAuth, async (req, res, next) => {
  const authUser = (req as AuthRequest).authUser!;
  const parsed = z.object({
    customerId: z.string().uuid().optional(),
    trainerId: z.string().uuid().optional(),
  }).refine(v => Boolean(v.customerId) !== Boolean(v.trainerId), 'Provide exactly one of customerId or trainerId').safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_QUERY', message: 'Provide exactly one UUID: customerId or trainerId' });
    return;
  }
  if (authUser.role === 'CUSTOMER' && parsed.data.customerId !== authUser.id) { res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot view another customer bookings' }); return; }
  if (authUser.role === 'TRAINER' && parsed.data.trainerId !== authUser.id) { res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot view another trainer bookings' }); return; }
  if (authUser.role === 'OPS' && !parsed.data.customerId && !parsed.data.trainerId) { res.status(400).json({ error: 'INVALID_QUERY' }); return; }
  if (authUser.role === 'CUSTOMER' && parsed.data.trainerId || authUser.role === 'TRAINER' && parsed.data.customerId) { res.status(403).json({ error: 'FORBIDDEN' }); return; }
  try {
    const key = parsed.data.customerId ? 'customer_id' : 'trainer_id';
    const value = parsed.data.customerId ?? parsed.data.trainerId;
    const result = await pool!.query(
      `select b.*, cu.display_name as customer_name, tr.display_name as trainer_name
       from bookings b
       join users cu on cu.id = b.customer_id
       left join users tr on tr.id = b.trainer_id
       where b.${key} = $1 order by b.starts_at desc limit 100`,
      [value],
    );
    res.json({ bookings: result.rows });
  } catch (error) { next(error); }
});

// Trainer workspace: server owns session timestamps and completion state.
app.get('/api/trainer/sessions', requireAuth, requireRole('TRAINER'), async (req, res, next) => {
  const trainer = (req as AuthRequest).authUser!;
  try {
    // Recover sessions whose 60-minute duration elapsed while browser was closed.
    await pool!.query(
      `update bookings set status = 'COMPLETED', session_completed_at = session_started_at + interval '60 minutes', updated_at = now()
       where trainer_id = $1 and status = 'IN_PROGRESS'
         and session_started_at <= now() - interval '60 minutes'`,
      [trainer.id],
    );
    const result = await pool!.query(
      `select b.*, cu.display_name as customer_name
       from bookings b join users cu on cu.id = b.customer_id
       where b.trainer_id = $1
       order by case b.status when 'IN_PROGRESS' then 0 when 'CONFIRMED' then 1 else 2 end, b.starts_at asc
       limit 100`,
      [trainer.id],
    );
    res.json({ sessions: result.rows, serverNow: new Date().toISOString() });
  } catch (error) { next(error); }
});

app.post('/api/trainer/sessions/:id/start', requireAuth, requireRole('TRAINER'), async (req, res, next) => {
  const trainer = (req as AuthRequest).authUser!;
  try {
    const result = await pool!.query(
      `update bookings
       set status = 'IN_PROGRESS', session_started_at = now(), updated_at = now()
       where id = $1 and trainer_id = $2 and status = 'CONFIRMED'
         and starts_at <= now() + interval '15 minutes' and ends_at > now()
       returning *`,
      [req.params.id, trainer.id],
    );
    if (!result.rowCount) {
      res.status(409).json({ error: 'SESSION_NOT_STARTABLE', message: 'Session must be assigned to you, confirmed, and within 15 minutes of its scheduled start' });
      return;
    }
    const booking = result.rows[0];
    await pool!.query(
      `insert into notifications (recipient_id, booking_id, event_type, message)
       values ($1, $2, 'SESSION_STARTED', 'Your trainer has started the session')`,
      [booking.customer_id, booking.id],
    );
    res.json({ booking, serverNow: new Date().toISOString(), durationSeconds: 3600, warningAtSeconds: 3300 });
  } catch (error) { next(error); }
});

app.post('/api/trainer/sessions/:id/complete', requireAuth, requireRole('TRAINER'), async (req, res, next) => {
  const trainer = (req as AuthRequest).authUser!;
  try {
    const result = await pool!.query(
      `update bookings
       set status = 'COMPLETED', session_completed_at = session_started_at + interval '60 minutes', updated_at = now()
       where id = $1 and trainer_id = $2 and status = 'IN_PROGRESS'
         and session_started_at <= now() - interval '60 minutes'
       returning *`,
      [req.params.id, trainer.id],
    );
    if (!result.rowCount) {
      const current = await pool!.query('select status, session_started_at from bookings where id = $1 and trainer_id = $2', [req.params.id, trainer.id]);
      if (!current.rowCount) { res.status(404).json({ error: 'SESSION_NOT_FOUND' }); return; }
      res.status(409).json({ error: 'SESSION_NOT_FINISHED', message: 'Session can complete only after 60 minutes from server-recorded start time' });
      return;
    }
    const booking = result.rows[0];
    await pool!.query(
      `insert into notifications (recipient_id, booking_id, event_type, message)
       values ($1, $2, 'SESSION_COMPLETED', 'Your training session is complete')`,
      [booking.customer_id, booking.id],
    );
    res.json({ booking });
  } catch (error) { next(error); }
});

app.patch('/api/bookings/:id/cancel', requireAuth, requireRole('CUSTOMER'), async (req, res, next) => {
  const authUser = (req as AuthRequest).authUser!;
  const parsed = z.object({
    customerId: z.string().uuid(),
    reason: z.string().trim().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_CANCELLATION', details: parsed.error.flatten() });
    return;
  }
  if (parsed.data.customerId !== authUser.id) { res.status(403).json({ error: 'FORBIDDEN' }); return; }
  try {
    const result = await pool!.query(
      `update bookings
       set status = 'CANCELLED', cancelled_at = now(), cancellation_reason = $3, updated_at = now()
       where id = $1 and customer_id = $2 and status = 'CONFIRMED' and starts_at > now()
       returning *`,
      [req.params.id, parsed.data.customerId, parsed.data.reason ?? null],
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'BOOKING_NOT_CANCELLABLE', message: 'Booking not found, not owned by customer, or no longer cancellable' });
      return;
    }
    const booking = result.rows[0];
    if (booking.trainer_id) {
      await pool!.query(
        `insert into notifications (recipient_id, booking_id, event_type, message)
         values ($1, $2, 'BOOKING_CANCELLED', 'A fitness session has been cancelled')`,
        [booking.trainer_id, booking.id],
      );
    }
    res.json({ booking });
  } catch (error) { next(error); }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Unexpected server error' });
});

app.listen(port, () => console.log(`Zuryo backend listening on http://localhost:${port}`));
process.on('SIGTERM', async () => { await pool?.end(); process.exit(0); });
