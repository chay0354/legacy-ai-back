import Stripe from 'stripe';
import {
  getPlan, isPaidStatus, planIdFromPriceId, priceIdForPlan,
} from './plans.js';
import {
  getBillingByCustomerId, getBillingByUserId, ownerUserIdForCreator, upsertBilling,
} from '../db/billingRepo.js';

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(key);
}

export function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && priceIdForPlan('archive') && priceIdForPlan('family'));
}

export function publicBilling(row) {
  const paid = isPaidStatus(row?.status, row?.currentPeriodEnd);
  return {
    plan: paid ? (row.plan || 'none') : 'none',
    status: row?.status || 'none',
    paid,
    cancelAtPeriodEnd: Boolean(row?.cancelAtPeriodEnd),
    currentPeriodEnd: row?.currentPeriodEnd || null,
    maxOwnedArchives: paid ? (getPlan(row.plan)?.maxOwnedArchives || 1) : 0,
    source: row?.source || null,
    notes: row?.notes || null,
    credits: row?.credits || [],
  };
}

async function refreshBillingFromStripe(req, userId) {
  if (!stripeConfigured()) return getBillingByUserId(req, userId);
  try {
    const existing = await getBillingByUserId(req, userId);
    const stripe = stripeClient();
    let customerId = existing?.stripeCustomerId || null;
    if (!customerId) {
      const email = req.userEmail || req.user?.email;
      if (email) {
        const list = await stripe.customers.list({ email, limit: 15 });
        const match = list.data.find((c) => c.metadata?.userId === userId) || list.data[0];
        customerId = match?.id || null;
      }
    }
    if (!customerId) return existing;
    const sub = await subscriptionForCustomer(customerId);
    if (!sub) return existing;
    return persistSubscription(req, {
      userId,
      customerId,
      subscription: sub,
      checkoutPaid: ['active', 'trialing', 'incomplete'].includes(sub.status),
    });
  } catch (e) {
    console.warn('[billing] stripe refresh failed:', e.message);
    return getBillingByUserId(req, userId);
  }
}

export async function billingForUser(req, userId) {
  const row = await getBillingByUserId(req, userId);
  if (isPaidStatus(row?.status, row?.currentPeriodEnd)) return publicBilling(row);
  return publicBilling(await refreshBillingFromStripe(req, userId));
}

export async function ownerIsPaid(req, creatorId) {
  const ownerId = await ownerUserIdForCreator(req, creatorId);
  if (!ownerId) return false;
  const billing = await billingForUser(req, ownerId);
  return billing.paid;
}

function paymentError(message) {
  const err = new Error(message);
  err.status = 402;
  err.code = 'PAYMENT_REQUIRED';
  return err;
}

/** Owner starting paid work on their own account. */
export async function assertUserPaid(req) {
  if (!stripeConfigured()) return publicBilling(null);
  const billing = await billingForUser(req, req.user.id);
  if (!billing.paid) {
    throw paymentError('Choose a plan to start the interview, live avatar, and family invitations.');
  }
  return billing;
}

/** Paid work billed to the archive owner (live call by family still needs the owner’s plan). */
export async function assertArchivePaid(req, creatorId) {
  if (!stripeConfigured()) return;
  if (!(await ownerIsPaid(req, creatorId))) {
    throw paymentError('This archive needs an active plan for live calls and new recordings.');
  }
}

/** Recent Stripe API versions report the renewal date on the subscription item. */
function periodEnd(sub) {
  const sec = sub?.current_period_end
    || sub?.items?.data?.[0]?.current_period_end
    || sub?.cancel_at
    || sub?.trial_end;
  return sec ? new Date(sec * 1000).toISOString() : null;
}

export async function rememberCustomer(req, userId, customerId) {
  const existing = await getBillingByUserId(req, userId);
  return upsertBilling(req, {
    userId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: existing?.stripeSubscriptionId,
    plan: existing?.plan || 'none',
    status: existing?.status || 'none',
    priceId: existing?.priceId,
    currentPeriodEnd: existing?.currentPeriodEnd,
    cancelAtPeriodEnd: existing?.cancelAtPeriodEnd,
  });
}

function checkoutLooksPaid(session) {
  const payment = String(session?.payment_status || '').toLowerCase();
  const status = String(session?.status || '').toLowerCase();
  return payment === 'paid' || status === 'complete';
}

function paidEnoughStatus(status, checkoutPaid) {
  const s = String(status || '').toLowerCase();
  if (s === 'active' || s === 'trialing') return s;
  // Card already captured; Stripe sometimes still reports incomplete for a few seconds.
  if (checkoutPaid && (s === 'incomplete' || s === 'past_due' || !s)) return 'active';
  return s || 'none';
}

export async function persistSubscription(req, { userId, customerId, subscription, checkoutPaid = false }) {
  const existing = await getBillingByUserId(req, userId);
  if (
    existing?.stripeSubscriptionId
    && subscription?.id
    && existing.stripeSubscriptionId !== subscription.id
  ) {
    try {
      await stripeClient().subscriptions.cancel(existing.stripeSubscriptionId);
    } catch (e) {
      console.warn('[billing] could not cancel previous subscription:', e.message);
    }
  }
  const item = subscription?.items?.data?.[0];
  const priceId = item?.price?.id || null;
  const plan = planIdFromPriceId(priceId)
    || subscription?.metadata?.plan
    || 'archive';
  return upsertBilling(req, {
    userId,
    stripeCustomerId: customerId || subscription?.customer || null,
    stripeSubscriptionId: subscription?.id || null,
    plan: getPlan(plan) ? plan : 'archive',
    status: paidEnoughStatus(subscription?.status, checkoutPaid),
    priceId,
    currentPeriodEnd: periodEnd(subscription),
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    source: 'stripe',
  });
}

export async function applyCheckoutSession(req, session) {
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const userId = session.metadata?.userId
    || session.client_reference_id
    || (await userIdFromCustomer(customerId));
  if (!userId) throw new Error('Checkout session missing userId');
  const stripe = stripeClient();
  let subscription = session.subscription;
  if (typeof subscription === 'string') {
    subscription = await stripe.subscriptions.retrieve(subscription);
  }
  if (!subscription) throw new Error('Checkout session has no subscription');
  return persistSubscription(req, {
    userId,
    customerId,
    subscription,
    checkoutPaid: checkoutLooksPaid(session),
  });
}

async function subscriptionForCustomer(customerId) {
  if (!customerId) return null;
  const list = await stripeClient().subscriptions.list({ customer: customerId, limit: 8, status: 'all' });
  return list.data.find((s) => ['active', 'trialing', 'incomplete', 'past_due'].includes(s.status))
    || list.data[0]
    || null;
}

function forcedPaid(plan, row, period) {
  return {
    plan,
    status: 'active',
    paid: true,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: row?.currentPeriodEnd || period,
    maxOwnedArchives: getPlan(plan)?.maxOwnedArchives || 1,
    source: 'stripe',
    notes: row?.notes || null,
    credits: row?.credits || [],
  };
}

/**
 * After Checkout redirects back. One Stripe read — if they paid, the archive opens now.
 */
export async function syncCheckoutSession(req, sessionId, userId) {
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription'],
  });
  if (typeof session.subscription === 'string') {
    try {
      session.subscription = await stripe.subscriptions.retrieve(session.subscription);
    } catch (e) {
      console.warn('[billing] subscription retrieve failed:', e.message);
    }
  }
  if (!session.subscription) {
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    session.subscription = await subscriptionForCustomer(customerId);
  }

  const uid = session.metadata?.userId || session.client_reference_id || userId;
  if (uid && userId && uid !== userId) {
    const err = new Error('This checkout belongs to another account.');
    err.status = 403;
    throw err;
  }

  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const plan = session.metadata?.plan === 'family' ? 'family' : 'archive';
  const end = new Date();
  end.setMonth(end.getMonth() + 1);
  const period = periodEnd(session.subscription) || end.toISOString();

  let row = null;
  try {
    if (session.subscription) {
      row = await applyCheckoutSession(req, session);
    } else if (checkoutLooksPaid(session)) {
      row = await upsertBilling(req, {
        userId: uid || userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: null,
        plan,
        status: 'active',
        currentPeriodEnd: period,
        cancelAtPeriodEnd: false,
        source: 'stripe',
        notes: 'Opened from a completed Checkout session.',
      });
    }
  } catch (err) {
    console.warn('[billing] persist after checkout failed:', err.message);
  }

  const fromStore = publicBilling(row);
  if (fromStore.paid) return fromStore;
  if (checkoutLooksPaid(session) || session.subscription) {
    return forcedPaid(plan, row, period);
  }
  return billingForUser(req, userId);
}

/** Every customer we create carries userId, so it resolves events that lost their metadata. */
async function userIdFromCustomer(customerId) {
  if (!customerId) return null;
  try {
    const customer = await stripeClient().customers.retrieve(customerId);
    return customer?.deleted ? null : (customer?.metadata?.userId || null);
  } catch (e) {
    console.warn('[billing] could not read customer metadata:', e.message);
    return null;
  }
}

export async function applySubscriptionEvent(req, subscription) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;
  const userId = subscription.metadata?.userId
    || (await getBillingByCustomerId(req, customerId))?.userId
    || (await userIdFromCustomer(customerId));
  if (!userId) {
    console.warn('[billing] subscription event with no user', subscription.id);
    return null;
  }
  return persistSubscription(req, { userId, customerId, subscription });
}

export function adminReq() {
  return {};
}
