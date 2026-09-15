/**
 * Create The Archive + Family prices in Stripe if they do not already exist.
 * Prints price IDs for .env — does not print secret keys.
 */
import 'dotenv/config';
import Stripe from 'stripe';
import { PLANS } from '../src/services/plans.js';

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
    && p.recurring?.interval === plan.interval,
  );
  if (match) return match;
  return stripe.prices.create({
    product: product.id,
    unit_amount: plan.amount,
    currency: plan.currency,
    recurring: { interval: plan.interval },
    metadata: { legacy_plan: plan.id },
  });
}

const archive = await ensurePrice(PLANS.archive);
const family = await ensurePrice(PLANS.family);
console.log(`STRIPE_PRICE_ARCHIVE=${archive.id}`);
console.log(`STRIPE_PRICE_FAMILY=${family.id}`);
