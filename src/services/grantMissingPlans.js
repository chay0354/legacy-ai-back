import { getAdminClient } from '../middleware/auth.js';
import { isPaidStatus } from './plans.js';
import { billingForUser } from './stripeBilling.js';
import { countOwnedArchives, getBillingByUserId, upsertBilling } from '../db/billingRepo.js';

function serviceReq() {
  const admin = getAdminClient();
  return { admin, supabase: admin };
}

async function listAuthUsers(admin) {
  const out = [];
  for (let page = 1; page <= 25; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const batch = data?.users || [];
    out.push(...batch);
    if (batch.length < 200) break;
  }
  return out;
}

/**
 * Every account without an active plan gets one.
 * The Archive if they have 0–1 archives; Family if they already have two or more.
 * Existing paid Stripe / credit rows are left alone.
 */
export async function grantMissingPlans() {
  const admin = getAdminClient();
  if (!admin) throw new Error('Supabase service role is not configured.');
  const req = serviceReq();
  const users = await listAuthUsers(admin);
  const granted = [];
  const already = [];
  const failed = [];

  for (const user of users) {
    try {
      const live = await billingForUser({ ...req, userEmail: user.email, user }, user.id);
      if (live.paid) {
        already.push({ id: user.id, email: user.email, plan: live.plan });
        continue;
      }
      const owned = await countOwnedArchives(req, user.id);
      const plan = owned >= 2 ? 'family' : 'archive';
      const existing = await getBillingByUserId(req, user.id);
      const row = await upsertBilling(req, {
        userId: user.id,
        stripeCustomerId: existing?.stripeCustomerId || null,
        stripeSubscriptionId: existing?.stripeSubscriptionId || null,
        plan,
        status: 'active',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        source: 'comp',
        notes: 'Opened for existing accounts so everyone has a plan.',
        credits: existing?.credits || [],
      });
      if (!isPaidStatus(row?.status, row?.currentPeriodEnd)) {
        failed.push({ id: user.id, email: user.email, error: 'write did not stick as paid' });
        continue;
      }
      granted.push({ id: user.id, email: user.email, plan });
    } catch (err) {
      failed.push({ id: user.id, email: user.email, error: err.message });
    }
  }

  return {
    users: users.length,
    granted: granted.length,
    already: already.length,
    failed: failed.length,
    details: { granted, already, failed },
  };
}
