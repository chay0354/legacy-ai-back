import { getAdminClient } from '../middleware/auth.js';
import {
  formatMoney, getPlan, PLAN_IDS, priceIdForPlan, setPriceOverride,
} from './plans.js';
import { stripeClient, stripeConfigured } from './stripeBilling.js';

export const EDITABLE_PLANS = ['setup', 'monthly', 'storage', 'addon'];

export async function loadPriceOverrides(admin = getAdminClient()) {
  if (!admin) return;
  const { data, error } = await admin.from('legacy_plan_prices').select('plan_id, amount_cents, stripe_price_id');
  if (error) {
    console.warn('[prices] could not load overrides:', error.message);
    return;
  }
  for (const row of data || []) {
    if (!PLAN_IDS.includes(row.plan_id)) continue;
    setPriceOverride(row.plan_id, Number(row.amount_cents), row.stripe_price_id);
  }
}

export function editablePriceList() {
  return EDITABLE_PLANS.map((id) => {
    const plan = getPlan(id);
    return {
      id,
      name: plan.name,
      amount: plan.amount,
      displayPrice: formatMoney(plan.amount, plan.currency),
      interval: plan.interval,
      stripePriceId: priceIdForPlan(id) || null,
    };
  });
}

async function productForPlan(stripe, planId) {
  const found = await stripe.products.search({
    query: `metadata['legacy_plan']:'${planId}' AND active:'true'`,
  });
  if (found.data[0]) return found.data[0].id;
  const existingId = priceIdForPlan(planId);
  if (existingId) {
    const price = await stripe.prices.retrieve(existingId);
    return typeof price.product === 'string' ? price.product : price.product?.id;
  }
  const plan = getPlan(planId);
  const created = await stripe.products.create({
    name: `Legacy ${plan.name}`,
    metadata: { legacy_plan: planId },
  });
  return created.id;
}

export async function updatePlanPrice(planId, dollars) {
  if (!EDITABLE_PLANS.includes(planId)) {
    const err = new Error('That package cannot be repriced from the desk.');
    err.status = 400;
    throw err;
  }
  if (!stripeConfigured()) {
    const err = new Error('Stripe is not configured on this server.');
    err.status = 503;
    throw err;
  }
  const cents = Math.round(Number(dollars) * 100);
  if (!Number.isFinite(cents) || cents < 50 || cents > 10000000) {
    const err = new Error('Enter a price between $0.50 and $100,000.');
    err.status = 400;
    throw err;
  }
  const admin = getAdminClient();
  if (!admin) {
    const err = new Error('Supabase service role is not configured.');
    err.status = 503;
    throw err;
  }
  await loadPriceOverrides(admin);
  const plan = getPlan(planId);
  const stripe = stripeClient();
  const productId = await productForPlan(stripe, planId);
  const created = await stripe.prices.create({
    product: productId,
    unit_amount: cents,
    currency: plan.currency || 'usd',
    ...(plan.interval ? { recurring: { interval: plan.interval } } : {}),
  });
  const { error } = await admin.from('legacy_plan_prices').upsert({
    plan_id: planId,
    amount_cents: cents,
    stripe_price_id: created.id,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  setPriceOverride(planId, cents, created.id);
  return editablePriceList().find((row) => row.id === planId);
}
