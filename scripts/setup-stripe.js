/**
 * Create Stripe products/prices for the current catalog if they do not already exist.
 * Prints price IDs for .env — does not print secret keys.
 */
import 'dotenv/config';
import Stripe from 'stripe';
import { PLANS, PUBLIC_PLAN_IDS, PLAN_IDS } from '../src/services/plans.js';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Set STRIPE_SECRET_KEY first');
  process.exit(1);
}

const stripe = new Stripe(key);

async function ensurePrice(plan) {
  const products = await stripe.products.search({
    query: `metadata['legacy_plan']:'${plan.id}' AND active:'true'`,
  });
  let product = products.data[0];
  if (!product) {
    product = await stripe.products.create({
      name: `Legacy AI — ${plan.name}`,
      description: plan.cadence,
      metadata: { legacy_plan: plan.id },
    });
  }
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 20 });
  const match = prices.data.find((p) =>
    p.unit_amount === plan.amount
    && p.currency === plan.currency
    && (plan.interval
      ? p.recurring?.interval === plan.interval
      : !p.recurring),
  );
  if (match) return match;
  const params = {
    product: product.id,
    unit_amount: plan.amount,
    currency: plan.currency,
    metadata: { legacy_plan: plan.id },
  };
  if (plan.interval) params.recurring = { interval: plan.interval };
  return stripe.prices.create(params);
}

const ids = PUBLIC_PLAN_IDS.concat(PLAN_IDS.filter((id) => !PUBLIC_PLAN_IDS.includes(id)));
const envName = {
  setup: 'STRIPE_PRICE_SETUP',
  monthly: 'STRIPE_PRICE_MONTHLY',
  preserve: 'STRIPE_PRICE_PRESERVE',
  addon: 'STRIPE_PRICE_ADDON',
  archive: 'STRIPE_PRICE_ARCHIVE',
  family: 'STRIPE_PRICE_FAMILY',
};

for (const id of ids) {
  const price = await ensurePrice(PLANS[id]);
  console.log(`${envName[id]}=${price.id}`);
}
