import { getPool } from './pool.js';
import { getAdminClient } from '../middleware/auth.js';

const COLS = 'user_id, stripe_customer_id, stripe_subscription_id, plan, status, price_id, current_period_end, cancel_at_period_end, updated_at';

function mapRow(row, extras = {}) {
  if (!row) return null;
  return {
    userId: row.user_id,
    stripeCustomerId: row.stripe_customer_id || null,
    stripeSubscriptionId: row.stripe_subscription_id || null,
    plan: row.plan || 'none',
    status: row.status || 'none',
    priceId: row.price_id || null,
    currentPeriodEnd: row.current_period_end || null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    updatedAt: row.updated_at || null,
    source: extras.source || row.source || null,
    notes: extras.notes || row.notes || null,
    credits: extras.credits || row.credits || [],
    minutesRemaining: Number.isFinite(Number(extras.minutesRemaining))
      ? Number(extras.minutesRemaining)
      : Number(row.minutes_remaining) || 0,
  };
}

function tableUnavailable(err) {
  return /legacy_billing|does not exist|42P01|schema cache|password authentication|ECONNREFUSED/i.test(err?.message || '');
}

function adminFrom(req) {
  // Never fall back to the caller's user client — Auth then answers "User not allowed".
  if (req?.admin?.auth?.admin && req.admin !== req.supabase) return req.admin;
  return getAdminClient();
}

function fromMeta(userId, billing) {
  if (!billing) return null;
  return {
    userId,
    stripeCustomerId: billing.stripeCustomerId || null,
    stripeSubscriptionId: billing.stripeSubscriptionId || null,
    plan: billing.plan || 'none',
    status: billing.status || 'none',
    priceId: billing.priceId || null,
    currentPeriodEnd: billing.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(billing.cancelAtPeriodEnd),
    updatedAt: billing.updatedAt || null,
    source: billing.source || null,
    notes: billing.notes || null,
    credits: Array.isArray(billing.credits) ? billing.credits : [],
    minutesRemaining: Number(billing.minutesRemaining) || 0,
  };
}

async function readAppMeta(req, userId) {
  const admin = adminFrom(req);
  if (!admin?.auth?.admin) return null;
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error) return null;
  return fromMeta(userId, data.user?.app_metadata?.billing);
}

async function writeAppMeta(req, mapped) {
  const admin = adminFrom(req);
  if (!admin?.auth?.admin) return mapped;
  const { data, error: readErr } = await admin.auth.admin.getUserById(mapped.userId);
  if (readErr) {
    console.warn('[billing] could not read user metadata:', readErr.message);
    return mapped;
  }
  const prev = data?.user?.app_metadata || {};
  const { error } = await admin.auth.admin.updateUserById(mapped.userId, {
    app_metadata: {
      ...prev,
      billing: {
        stripeCustomerId: mapped.stripeCustomerId,
        stripeSubscriptionId: mapped.stripeSubscriptionId,
        plan: mapped.plan,
        status: mapped.status,
        priceId: mapped.priceId,
        currentPeriodEnd: mapped.currentPeriodEnd,
        cancelAtPeriodEnd: mapped.cancelAtPeriodEnd,
        updatedAt: mapped.updatedAt,
        source: mapped.source || null,
        notes: mapped.notes || null,
        credits: mapped.credits || [],
        minutesRemaining: mapped.minutesRemaining || 0,
      },
    },
  });
  if (error) {
    console.warn('[billing] could not write user metadata:', error.message);
    return mapped;
  }
  return mapped;
}

export async function getBillingByUserId(req, userId) {
  if (!userId) return null;
  const db = getPool();
  if (db) {
    try {
      const { rows } = await db.query(
        `SELECT ${COLS} FROM legacy_billing WHERE user_id = $1`,
        [userId],
      );
      if (rows[0]) {
        const meta = await readAppMeta(req, userId);
        return mapRow(rows[0], meta || {});
      }
    } catch (err) {
      if (!tableUnavailable(err)) throw err;
    }
  }
  try {
    const client = req?.admin || req?.supabase;
    if (client) {
      const { data, error } = await client.from('legacy_billing').select('*').eq('user_id', userId).maybeSingle();
      if (!error && data) {
        const meta = await readAppMeta(req, userId);
        return mapRow(data, meta || {});
      }
    }
  } catch (err) {
    if (!tableUnavailable(err)) throw err;
  }
  return readAppMeta(req, userId);
}

export async function getBillingByCustomerId(req, customerId) {
  if (!customerId) return null;
  const db = getPool();
  if (db) {
    try {
      const { rows } = await db.query(
        `SELECT ${COLS} FROM legacy_billing WHERE stripe_customer_id = $1`,
        [customerId],
      );
      if (rows[0]) return mapRow(rows[0]);
    } catch (err) {
      if (!tableUnavailable(err)) throw err;
    }
  }
  try {
    const client = req?.admin || req?.supabase;
    if (client) {
      const { data, error } = await client.from('legacy_billing').select('*').eq('stripe_customer_id', customerId).maybeSingle();
      if (!error && data) return mapRow(data);
    }
  } catch (err) {
    if (!tableUnavailable(err)) throw err;
  }
  return null;
}

function extrasFrom(patch, existing = {}) {
  return {
    source: patch.source !== undefined ? patch.source : (existing.source || null),
    notes: patch.notes !== undefined ? patch.notes : (existing.notes || null),
    credits: Array.isArray(patch.credits) ? patch.credits : (existing.credits || []),
    minutesRemaining: patch.minutesRemaining !== undefined
      ? Number(patch.minutesRemaining) || 0
      : (existing.minutesRemaining || 0),
  };
}

export async function upsertBilling(req, patch) {
  if (!patch?.userId) throw new Error('userId required');
  const existing = await getBillingByUserId(req, patch.userId).catch(() => null);
  const extras = extrasFrom(patch, existing || {});
  const row = {
    user_id: patch.userId,
    stripe_customer_id: patch.stripeCustomerId ?? null,
    stripe_subscription_id: patch.stripeSubscriptionId ?? null,
    plan: patch.plan || 'none',
    status: patch.status || 'none',
    price_id: patch.priceId ?? null,
    current_period_end: patch.currentPeriodEnd ?? null,
    cancel_at_period_end: patch.cancelAtPeriodEnd ?? false,
    updated_at: new Date().toISOString(),
  };

  const db = getPool();
  if (db) {
    try {
      const { rows } = await db.query(
        `INSERT INTO legacy_billing (
           user_id, stripe_customer_id, stripe_subscription_id, plan, status, price_id,
           current_period_end, cancel_at_period_end, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id) DO UPDATE SET
           stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, legacy_billing.stripe_customer_id),
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           plan = EXCLUDED.plan,
           status = EXCLUDED.status,
           price_id = EXCLUDED.price_id,
           current_period_end = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           updated_at = EXCLUDED.updated_at
         RETURNING ${COLS}`,
        [
          row.user_id, row.stripe_customer_id, row.stripe_subscription_id, row.plan, row.status,
          row.price_id, row.current_period_end, row.cancel_at_period_end, row.updated_at,
        ],
      );
      const mapped = mapRow(rows[0], extras);
      await writeAppMeta(req, mapped).catch(() => {});
      return mapped;
    } catch (err) {
      if (!tableUnavailable(err)) throw err;
    }
  }

  try {
    const client = adminFrom(req);
    if (client) {
      const { data, error } = await client
        .from('legacy_billing')
        .upsert(row, { onConflict: 'user_id' })
        .select('*')
        .single();
      if (!error && data) {
        const mapped = mapRow(data, extras);
        await writeAppMeta(req, mapped).catch(() => {});
        return mapped;
      }
    }
  } catch (err) {
    if (!tableUnavailable(err)) throw err;
  }

  return writeAppMeta(req, mapRow(row, extras));
}

export async function countOwnedArchives(req, userId) {
  const db = getPool();
  if (db) {
    try {
      const { rows } = await db.query(
        'SELECT count(*)::int AS n FROM legacy_creators WHERE user_id = $1',
        [userId],
      );
      return rows[0]?.n || 0;
    } catch (err) {
      if (!tableUnavailable(err)) throw err;
    }
  }
  const client = req?.admin || req?.supabase;
  if (!client) return 0;
  const { count, error } = await client
    .from('legacy_creators')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return count || 0;
}

export async function ownerUserIdForCreator(req, creatorId) {
  if (!creatorId) return null;
  const db = getPool();
  if (db) {
    try {
      const { rows } = await db.query('SELECT user_id FROM legacy_creators WHERE id = $1', [creatorId]);
      return rows[0]?.user_id || null;
    } catch (err) {
      if (!tableUnavailable(err)) throw err;
    }
  }
  const client = req?.admin || req?.supabase;
  if (!client) return null;
  const { data, error } = await client.from('legacy_creators').select('user_id').eq('id', creatorId).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.user_id || null;
}
