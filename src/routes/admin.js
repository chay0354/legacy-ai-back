import { Router } from 'express';
import { getAdminClient } from '../middleware/auth.js';
import {
  adminConfigured, credentialsMatch, requireAdmin, signAdminToken,
} from '../middleware/adminAuth.js';
import { getPlan } from '../services/plans.js';
import { grantMissingPlans } from '../services/grantMissingPlans.js';
import { publicBilling, stripeClient, stripeConfigured } from '../services/stripeBilling.js';
import { getBillingByUserId, upsertBilling } from '../db/billingRepo.js';
import { getPool } from '../db/pool.js';

const router = Router();

function serviceReq() {
  const admin = getAdminClient();
  return { admin, supabase: admin };
}

function extendPeriod(existingIso, months) {
  const now = Date.now();
  const existing = existingIso ? new Date(existingIso).getTime() : 0;
  const start = Number.isFinite(existing) && existing > now ? existing : now;
  const next = new Date(start);
  next.setMonth(next.getMonth() + months);
  return next.toISOString();
}

async function applyBilling(userId, patch) {
  const req = serviceReq();
  const existing = await getBillingByUserId(req, userId) || {};
  return upsertBilling(req, {
    userId,
    stripeCustomerId: patch.stripeCustomerId !== undefined ? patch.stripeCustomerId : existing.stripeCustomerId,
    stripeSubscriptionId: patch.stripeSubscriptionId !== undefined ? patch.stripeSubscriptionId : existing.stripeSubscriptionId,
    plan: patch.plan !== undefined ? patch.plan : existing.plan,
    status: patch.status !== undefined ? patch.status : existing.status,
    priceId: patch.priceId !== undefined ? patch.priceId : existing.priceId,
    currentPeriodEnd: patch.currentPeriodEnd !== undefined ? patch.currentPeriodEnd : existing.currentPeriodEnd,
    cancelAtPeriodEnd: patch.cancelAtPeriodEnd !== undefined ? patch.cancelAtPeriodEnd : existing.cancelAtPeriodEnd,
    source: patch.source !== undefined ? patch.source : existing.source,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    credits: patch.credits !== undefined ? patch.credits : existing.credits,
  });
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

async function listCreators(admin) {
  const { data, error } = await admin
    .from('legacy_creators')
    .select('id, user_id, display_name, avatar_level, completion_score, gender, pronouns, created_at, updated_at')
    .order('created_at', { ascending: false });
  if (error && !/does not exist|schema cache/i.test(error.message)) throw new Error(error.message);
  return data || [];
}

async function listMembers(admin, creatorId) {
  const q = admin.from('legacy_members').select('id, creator_id, user_id, role, created_at');
  const { data, error } = creatorId
    ? await q.eq('creator_id', creatorId)
    : await q;
  if (error && !/does not exist|schema cache/i.test(error.message)) throw new Error(error.message);
  return data || [];
}

async function listInvitations(admin, creatorId) {
  const q = admin.from('legacy_invitations').select('*').order('created_at', { ascending: false });
  const { data, error } = creatorId
    ? await q.eq('creator_id', creatorId)
    : await q.limit(200);
  if (error && !/does not exist|schema cache/i.test(error.message)) throw new Error(error.message);
  return data || [];
}

async function countMemories(admin, creatorId) {
  const { count, error } = await admin
    .from('legacy_memories')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creatorId);
  if (error) return 0;
  return count || 0;
}

function summarizeUser(user, billingRow, archives) {
  const billing = publicBilling(billingRow);
  return {
    id: user.id,
    email: user.email || null,
    name: user.user_metadata?.full_name || null,
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at || null,
    emailConfirmed: Boolean(user.email_confirmed_at),
    banned: Boolean(user.banned_until),
    billing,
    archiveCount: archives.length,
    archives: archives.map((a) => ({
      id: a.id,
      displayName: a.display_name,
      avatarLevel: a.avatar_level,
      completionScore: a.completion_score,
    })),
  };
}

router.get('/configured', (_req, res) => {
  res.json({ configured: adminConfigured() });
});

router.post('/login', (req, res) => {
  if (!adminConfigured()) {
    return res.status(503).json({ error: 'Admin login is not configured on this server.' });
  }
  const email = String(req.body?.email || '');
  const password = String(req.body?.password || '');
  if (!credentialsMatch(email, password)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  const token = signAdminToken(String(email).trim().toLowerCase());
  res.json({ token, email: String(email).trim().toLowerCase(), expiresInHours: 12 });
});

router.get('/overview', requireAdmin, async (_req, res) => {
  try {
    const admin = getAdminClient();
    if (!admin) return res.status(503).json({ error: 'Supabase service role is not configured.' });
    const [users, creators, invitations] = await Promise.all([
      listAuthUsers(admin),
      listCreators(admin),
      listInvitations(admin),
    ]);
    const reqCtx = serviceReq();
    let paid = 0;
    let credits = 0;
    for (const user of users) {
      const row = await getBillingByUserId(reqCtx, user.id);
      const pub = publicBilling(row);
      if (pub.paid) paid += 1;
      if (row?.source === 'credit' || (row?.credits || []).length) credits += 1;
    }
    res.json({
      users: users.length,
      paid,
      unpaid: users.length - paid,
      credited: credits,
      archives: creators.length,
      pendingInvitations: invitations.filter((i) => i.status === 'pending').length,
      stripe: stripeConfigured(),
      dbMode: getPool() ? 'postgres' : 'supabase-api',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/users', requireAdmin, async (req, res) => {
  try {
    const admin = getAdminClient();
    if (!admin) return res.status(503).json({ error: 'Supabase service role is not configured.' });
    const q = String(req.query.q || '').trim().toLowerCase();
    const [users, creators] = await Promise.all([listAuthUsers(admin), listCreators(admin)]);
    const byOwner = new Map();
    for (const c of creators) {
      const list = byOwner.get(c.user_id) || [];
      list.push(c);
      byOwner.set(c.user_id, list);
    }
    const reqCtx = serviceReq();
    const rows = [];
    for (const user of users) {
      const hay = `${user.email || ''} ${user.user_metadata?.full_name || ''} ${user.id}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const billing = await getBillingByUserId(reqCtx, user.id);
      rows.push(summarizeUser(user, billing, byOwner.get(user.id) || []));
    }
    rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/users/:id', requireAdmin, async (req, res) => {
  try {
    const admin = getAdminClient();
    if (!admin) return res.status(503).json({ error: 'Supabase service role is not configured.' });
    const { data, error } = await admin.auth.admin.getUserById(req.params.id);
    if (error || !data?.user) return res.status(404).json({ error: 'User not found' });
    const user = data.user;
    const reqCtx = serviceReq();
    const billingRow = await getBillingByUserId(reqCtx, user.id);
    const { data: archives, error: archErr } = await admin
      .from('legacy_creators')
      .select('*')
      .eq('user_id', user.id);
    if (archErr && !/does not exist|schema cache/i.test(archErr.message)) throw new Error(archErr.message);

    const detailed = [];
    for (const archive of archives || []) {
      const [members, invitations, memories] = await Promise.all([
        listMembers(admin, archive.id),
        listInvitations(admin, archive.id),
        countMemories(admin, archive.id),
      ]);
      detailed.push({
        ...archive,
        memoryCount: memories,
        members,
        invitations,
      });
    }

    const memberships = await listMembers(admin);
    const shared = memberships.filter((m) => m.user_id === user.id);

    res.json({
      user: summarizeUser(user, billingRow, archives || []),
      billing: {
        ...publicBilling(billingRow),
        stripeCustomerId: billingRow?.stripeCustomerId || null,
        stripeSubscriptionId: billingRow?.stripeSubscriptionId || null,
        source: billingRow?.source || null,
        notes: billingRow?.notes || null,
        credits: billingRow?.credits || [],
      },
      archives: detailed,
      memberships: shared,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/grant-missing-plans', requireAdmin, async (_req, res) => {
  try {
    res.json(await grantMissingPlans());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/plan', requireAdmin, async (req, res) => {
  try {
    const allowed = new Set(['setup', 'monthly', 'preserve', 'archive', 'family', 'none']);
    const plan = allowed.has(req.body?.plan) ? req.body.plan : 'monthly';
    const lifetime = Boolean(req.body?.lifetime);
    const status = plan === 'none' ? 'canceled' : 'active';
    const row = await applyBilling(req.params.id, {
      plan,
      status,
      currentPeriodEnd: lifetime || plan === 'none' ? null : undefined,
      source: plan === 'none' ? 'admin' : 'comp',
      notes: String(req.body?.notes || '').slice(0, 400) || (plan === 'none' ? 'Access removed by admin' : 'Complimentary plan set by admin'),
    });
    res.json(publicBilling(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/credit', requireAdmin, async (req, res) => {
  try {
    const months = Math.max(1, Math.min(36, Number(req.body?.months) || 1));
    const plan = req.body?.plan === 'family' ? 'family' : 'archive';
    if (!getPlan(plan)) return res.status(400).json({ error: 'Unknown plan' });
    const note = String(req.body?.notes || '').slice(0, 400);
    const existing = await getBillingByUserId(serviceReq(), req.params.id);
    const entry = {
      at: new Date().toISOString(),
      months,
      plan,
      notes: note || `Admin credit: ${months} month${months === 1 ? '' : 's'} of ${plan}`,
    };
    const row = await applyBilling(req.params.id, {
      plan,
      status: 'active',
      currentPeriodEnd: extendPeriod(existing?.currentPeriodEnd, months),
      source: 'credit',
      notes: entry.notes,
      credits: [...(existing?.credits || []), entry],
    });
    res.json({ billing: publicBilling(row), credit: entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/revoke', requireAdmin, async (req, res) => {
  try {
    const existing = await getBillingByUserId(serviceReq(), req.params.id);
    if (existing?.stripeSubscriptionId && stripeConfigured()) {
      try {
        await stripeClient().subscriptions.cancel(existing.stripeSubscriptionId);
      } catch (e) {
        console.warn('[admin] could not cancel Stripe subscription:', e.message);
      }
    }
    const row = await applyBilling(req.params.id, {
      plan: 'none',
      status: 'canceled',
      currentPeriodEnd: existing?.currentPeriodEnd || null,
      cancelAtPeriodEnd: false,
      source: 'admin',
      notes: String(req.body?.notes || 'Access revoked by admin').slice(0, 400),
    });
    res.json(publicBilling(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/confirm-email', requireAdmin, async (req, res) => {
  try {
    const admin = getAdminClient();
    const { data, error } = await admin.auth.admin.updateUserById(req.params.id, { email_confirm: true });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true, email: data.user?.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const admin = getAdminClient();
    const { data: archives } = await admin.from('legacy_creators').select('id').eq('user_id', req.params.id);
    for (const archive of archives || []) {
      await admin.from('legacy_members').delete().eq('creator_id', archive.id);
      await admin.from('legacy_invitations').delete().eq('creator_id', archive.id);
      await admin.from('legacy_creators').delete().eq('id', archive.id);
    }
    const { error } = await admin.auth.admin.deleteUser(req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/archives/:id', requireAdmin, async (req, res) => {
  try {
    const admin = getAdminClient();
    const patch = { updated_at: new Date().toISOString() };
    if (typeof req.body?.displayName === 'string') patch.display_name = req.body.displayName.trim().slice(0, 80);
    if (req.body?.avatarLevel != null) patch.avatar_level = Math.max(0, Math.min(3, Number(req.body.avatarLevel) || 0));
    if (req.body?.completionScore != null) {
      patch.completion_score = Math.max(0, Math.min(100, Number(req.body.completionScore) || 0));
    }
    const { data, error } = await admin.from('legacy_creators').update(patch).eq('id', req.params.id).select('*').single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ archive: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/archives/:id', requireAdmin, async (req, res) => {
  try {
    const admin = getAdminClient();
    await admin.from('legacy_members').delete().eq('creator_id', req.params.id);
    await admin.from('legacy_invitations').delete().eq('creator_id', req.params.id);
    const { error } = await admin.from('legacy_creators').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/members/:userId', requireAdmin, async (req, res) => {
  try {
    const admin = getAdminClient();
    const creatorId = String(req.body?.creatorId || '').trim();
    const role = String(req.body?.role || '').trim();
    if (!creatorId) return res.status(400).json({ error: 'creatorId required' });
    if (!['creator', 'administrator', 'member'].includes(role)) {
      return res.status(400).json({ error: 'role must be creator, administrator, or member' });
    }
    const { data, error } = await admin
      .from('legacy_members')
      .update({ role })
      .eq('creator_id', creatorId)
      .eq('user_id', req.params.userId)
      .select('*')
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ member: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/members/:userId', requireAdmin, async (req, res) => {
  try {
    const admin = getAdminClient();
    const creatorId = String(req.query.creatorId || req.body?.creatorId || '').trim();
    if (!creatorId) return res.status(400).json({ error: 'creatorId required' });
    const { error } = await admin
      .from('legacy_members')
      .delete()
      .eq('creator_id', creatorId)
      .eq('user_id', req.params.userId);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/invitations/:id', requireAdmin, async (req, res) => {
  try {
    const admin = getAdminClient();
    const { error } = await admin.from('legacy_invitations').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
