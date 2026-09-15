import Stripe from 'stripe';
import {
  addonOffer, getPlan, isAddonPlan, isPaidStatus, planCanInterview, planCanViewArchive,
  planIdFromPriceId, planUsesMinutes, priceIdForPlan, setResolvedPrice,
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
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Env first; if production never got the new price IDs, find them on the Stripe product. */
export async function resolvePriceId(planId) {
  const fromEnv = priceIdForPlan(planId);
  if (fromEnv) return fromEnv;
  if (!process.env.STRIPE_SECRET_KEY || !getPlan(planId)) return '';
  try {
    const plan = getPlan(planId);
    const products = await stripeClient().products.search({
      query: `metadata['legacy_plan']:'${planId}' AND active:'true'`,
    });
    const product = products.data[0];
    if (!product) return '';
    const prices = await stripeClient().prices.list({ product: product.id, active: true, limit: 20 });
    const match = prices.data.find((p) =>
      p.unit_amount === plan.amount
      && p.currency === plan.currency
      && (plan.interval ? p.recurring?.interval === plan.interval : !p.recurring),
    ) || prices.data[0];
    if (!match?.id) return '';
    setResolvedPrice(planId, match.id);
    return match.id;
  } catch (e) {
    console.warn('[billing] could not resolve Stripe price for', planId, e.message);
    return '';
  }
}

export function publicBilling(row) {
  const paid = isPaidStatus(row?.status, row?.currentPeriodEnd);
  const plan = paid ? (row.plan || 'none') : 'none';
  const usesMinutes = paid && planUsesMinutes(plan);
  const minutesRemaining = paid ? (Number(row?.minutesRemaining) || 0) : 0;
  const canViewArchive = paid && planCanViewArchive(plan);
  return {
    plan,
    status: row?.status || 'none',
    paid,
    cancelAtPeriodEnd: Boolean(row?.cancelAtPeriodEnd),
    currentPeriodEnd: row?.currentPeriodEnd || null,
    maxOwnedArchives: paid ? (getPlan(plan)?.maxOwnedArchives || 1) : 0,
    source: row?.source || null,
    notes: row?.notes || null,
    credits: row?.credits || [],
    minutesRemaining,
    usesMinutes,
    minutesExhausted: usesMinutes && minutesRemaining <= 0,
    canInterview: paid && planCanInterview(plan),
    canViewArchive,
    canBuyAddon: canViewArchive,
    addon: canViewArchive ? addonOffer() : null,
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
    const sessions = await stripe.checkout.sessions.list({ customer: customerId, limit: 15 });
    const paidSession = sessions.data.find((s) => checkoutLooksPaid(s));
    if (paidSession) {
      const full = await stripe.checkout.sessions.retrieve(paidSession.id, {
        expand: ['subscription', 'line_items.data.price'],
      });
      const row = await applyCheckoutSession(req, full);
      if (isPaidStatus(row?.status, row?.currentPeriodEnd)) return row;
    }
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

function paymentError(message, code = 'PAYMENT_REQUIRED') {
  const err = new Error(message);
  err.status = 402;
  err.code = code;
  return err;
}

function minutesError() {
  return paymentError('Your minutes are used. Add 30 minutes in Settings to continue.', 'MINUTES_REQUIRED');
}

/** Owner starting the interview (Preserve is enough). */
export async function assertUserPaid(req) {
  if (!stripeConfigured()) return publicBilling(null);
  const billing = await billingForUser(req, req.user.id);
  if (!billing.canInterview) {
    throw paymentError('Choose a plan to start the interview.');
  }
  if (billing.minutesExhausted) throw minutesError();
  return billing;
}

export async function assertCanViewArchive(req, creatorId) {
  if (!stripeConfigured()) return publicBilling(null);
  const ownerId = creatorId
    ? await ownerUserIdForCreator(req, creatorId)
    : req.user.id;
  if (!ownerId) throw paymentError('Choose a plan to see the archive.');
  const billing = await billingForUser(req, ownerId);
  if (!billing.canViewArchive) {
    throw paymentError('Pay Monthly or Set up to see the stories, people, and wisdom from this interview.');
  }
  return billing;
}

export async function ownerCanViewArchive(req, creatorId) {
  if (!stripeConfigured()) return true;
  const ownerId = await ownerUserIdForCreator(req, creatorId);
  if (!ownerId) return false;
  const billing = await billingForUser(req, ownerId);
  return Boolean(billing.canViewArchive);
}

/** Live avatar and family invitations need a plan that opens the archive. */
export async function assertArchivePaid(req, creatorId) {
  if (!stripeConfigured()) return;
  const ownerId = await ownerUserIdForCreator(req, creatorId);
  if (!ownerId) throw paymentError('This archive needs Monthly or Set up for live calls and family invitations.');
  const billing = await billingForUser(req, ownerId);
  if (!billing.canViewArchive) {
    throw paymentError('This archive needs Monthly or Set up for live calls and family invitations.');
  }
}

export async function assertOwnerHasMinutes(req, creatorId) {
  if (!stripeConfigured()) return;
  const ownerId = await ownerUserIdForCreator(req, creatorId);
  if (!ownerId) return;
  const billing = await billingForUser(req, ownerId);
  if (billing.minutesExhausted) throw minutesError();
}

export async function consumeMinutes(req, userId, durationSeconds) {
  const existing = await getBillingByUserId(req, userId);
  if (!existing || !planUsesMinutes(existing.plan)) return existing;
  if (!isPaidStatus(existing.status, existing.currentPeriodEnd)) return existing;
  const used = Math.max(1, Math.ceil((Number(durationSeconds) || 0) / 60));
  const next = Math.max(0, (Number(existing.minutesRemaining) || 0) - used);
  return upsertBilling(req, {
    userId,
    stripeCustomerId: existing.stripeCustomerId,
    stripeSubscriptionId: existing.stripeSubscriptionId,
    plan: existing.plan,
    status: existing.status,
    priceId: existing.priceId,
    currentPeriodEnd: existing.currentPeriodEnd,
    cancelAtPeriodEnd: existing.cancelAtPeriodEnd,
    source: existing.source,
    notes: existing.notes,
    credits: existing.credits,
    minutesRemaining: next,
  });
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
    minutesRemaining: existing?.minutesRemaining || 0,
  });
}

function checkoutLooksPaid(session) {
  const payment = String(session?.payment_status || '').toLowerCase();
  const status = String(session?.status || '').toLowerCase();
  return payment === 'paid' || payment === 'no_payment_required' || status === 'complete';
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
    || 'monthly';
  const resolved = getPlan(plan) ? plan : 'monthly';
  const spec = getPlan(resolved);
  const existingMinutes = Number(existing?.minutesRemaining) || 0;
  return upsertBilling(req, {
    userId,
    stripeCustomerId: customerId || subscription?.customer || null,
    stripeSubscriptionId: subscription?.id || null,
    plan: resolved,
    status: paidEnoughStatus(subscription?.status, checkoutPaid),
    priceId,
    currentPeriodEnd: periodEnd(subscription),
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    source: 'stripe',
    minutesRemaining: existingMinutes > 0 ? existingMinutes : (spec?.minutes || 0),
  });
}

function addMonthsIso(months) {
  const end = new Date();
  end.setMonth(end.getMonth() + months);
  return end.toISOString();
}

export async function persistOneTimePurchase(req, {
  userId, customerId, plan: rawPlan, priceId = null, checkoutPaid = false,
}) {
  if (!checkoutPaid) return getBillingByUserId(req, userId);
  const existing = await getBillingByUserId(req, userId);
  const plan = getPlan(rawPlan) ? rawPlan : 'preserve';

  if (isAddonPlan(plan)) {
    return upsertBilling(req, {
      userId,
      stripeCustomerId: customerId || existing?.stripeCustomerId || null,
      stripeSubscriptionId: existing?.stripeSubscriptionId || null,
      plan: existing?.plan || 'none',
      status: existing?.status || 'none',
      priceId: existing?.priceId || priceId,
      currentPeriodEnd: existing?.currentPeriodEnd || null,
      cancelAtPeriodEnd: existing?.cancelAtPeriodEnd || false,
      source: existing?.source || 'stripe',
      notes: existing?.notes || null,
      credits: existing?.credits || [],
      minutesRemaining: (Number(existing?.minutesRemaining) || 0) + (getPlan(plan)?.minutes || 30),
    });
  }

  if (plan === 'preserve' && planCanViewArchive(existing?.plan) && isPaidStatus(existing?.status, existing?.currentPeriodEnd)) {
    return existing;
  }

  const spec = getPlan(plan);
  const period = spec?.monthsIncluded ? addMonthsIso(spec.monthsIncluded) : null;
  const existingMinutes = Number(existing?.minutesRemaining) || 0;
  return upsertBilling(req, {
    userId,
    stripeCustomerId: customerId || existing?.stripeCustomerId || null,
    stripeSubscriptionId: existing?.stripeSubscriptionId || null,
    plan,
    status: 'active',
    priceId,
    currentPeriodEnd: period,
    cancelAtPeriodEnd: false,
    source: 'stripe',
    notes: plan === 'preserve'
      ? 'Interview only — pay Monthly or Set up to see the archive.'
      : existing?.notes || null,
    credits: existing?.credits || [],
    minutesRemaining: existingMinutes > 0 ? existingMinutes : (spec?.minutes || 0),
  });
}

export async function applyCheckoutSession(req, session) {
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const userId = session.metadata?.userId
    || session.client_reference_id
    || (await userIdFromCustomer(customerId));
  if (!userId) throw new Error('Checkout session missing userId');
  const plan = session.metadata?.plan
    || planIdFromPriceId(session.metadata?.priceId)
    || planIdFromPriceId(session.line_items?.data?.[0]?.price?.id)
    || 'monthly';
  const paid = checkoutLooksPaid(session);

  if (session.mode === 'payment' || isAddonPlan(plan) || getPlan(plan)?.checkoutMode === 'payment') {
    return persistOneTimePurchase(req, {
      userId,
      customerId,
      plan,
      priceId: session.metadata?.priceId || null,
      checkoutPaid: paid,
    });
  }

  const stripe = stripeClient();
  let subscription = session.subscription;
  if (typeof subscription === 'string') {
    subscription = await stripe.subscriptions.retrieve(subscription);
  }
  if (!subscription) {
    if (paid) {
      return persistOneTimePurchase(req, { userId, customerId, plan, checkoutPaid: true });
    }
    throw new Error('Checkout session has no subscription');
  }
  return persistSubscription(req, {
    userId,
    customerId,
    subscription,
    checkoutPaid: paid,
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
  return publicBilling({
    ...row,
    plan,
    status: 'active',
    currentPeriodEnd: row?.currentPeriodEnd || period,
    cancelAtPeriodEnd: false,
    source: 'stripe',
    minutesRemaining: row?.minutesRemaining || getPlan(plan)?.minutes || 0,
  });
}

/**
 * After Checkout redirects back. One Stripe read — if they paid, the archive opens now.
 */
export async function syncCheckoutSession(req, sessionId, userId) {
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'line_items.data.price'],
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
  const plan = session.metadata?.plan || 'monthly';
  const spec = getPlan(plan);
  const period = periodEnd(session.subscription)
    || (spec?.monthsIncluded ? addMonthsIso(spec.monthsIncluded) : addMonthsIso(1));

  let row = null;
  try {
    if (session.subscription || session.mode === 'payment' || checkoutLooksPaid(session)) {
      row = await applyCheckoutSession(req, session);
    }
  } catch (err) {
    console.warn('[billing] persist after checkout failed:', err.message);
  }

  const fromStore = publicBilling(row);
  if (fromStore.paid || (isAddonPlan(plan) && row)) return fromStore;
  if (checkoutLooksPaid(session) || session.subscription) {
    return forcedPaid(isAddonPlan(plan) ? (row?.plan || 'monthly') : plan, row, period);
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
