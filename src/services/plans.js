/** Customer plans. Amounts must match the Stripe Price objects. */
export const PLANS = {
  archive: {
    id: 'archive',
    name: 'The Archive',
    cadence: 'per month, one archive',
    amount: 1900,
    currency: 'usd',
    interval: 'month',
    maxOwnedArchives: 1,
    lines: [
      'Guided interview across all three stages',
      'Unlimited stories and entries',
      'Voice memories, photographs, and a live avatar',
      'Family access for the people you invite',
      'Edit or remove anything, at any time',
    ],
  },
  family: {
    id: 'family',
    name: 'Family',
    cadence: 'per month, more than one archive',
    amount: 3900,
    currency: 'usd',
    interval: 'month',
    maxOwnedArchives: 20,
    lines: [
      'Everything in The Archive',
      'Two or more archives, kept separately',
      'Administrator help for a parent or relative',
      'Shared family access settings',
    ],
  },
};

export const PLAN_IDS = Object.keys(PLANS);

export function getPlan(id) {
  return PLANS[id] || null;
}

export function priceEnvName(planId) {
  return planId === 'family' ? 'STRIPE_PRICE_FAMILY' : 'STRIPE_PRICE_ARCHIVE';
}

export function priceIdForPlan(planId) {
  return process.env[priceEnvName(planId)] || '';
}

export function planIdFromPriceId(priceId) {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_FAMILY) return 'family';
  if (priceId === process.env.STRIPE_PRICE_ARCHIVE) return 'archive';
  return null;
}

const ACTIVE = new Set(['active', 'trialing']);

export function isPaidStatus(status, currentPeriodEnd) {
  if (!ACTIVE.has(String(status || '').toLowerCase())) return false;
  if (!currentPeriodEnd) return true;
  const end = new Date(currentPeriodEnd);
  if (Number.isNaN(end.getTime())) return true;
  return end.getTime() > Date.now();
}

export function publicPlans() {
  return PLAN_IDS.map((id) => {
    const p = PLANS[id];
    return {
      id: p.id,
      name: p.name,
      cadence: p.cadence,
      amount: p.amount,
      currency: p.currency,
      interval: p.interval,
      displayPrice: formatMoney(p.amount, p.currency),
      lines: p.lines,
      primary: id === 'archive',
    };
  });
}

export function formatMoney(amountCents, currency = 'usd') {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
    }).format(amountCents / 100);
  } catch {
    return `$${(amountCents / 100).toFixed(0)}`;
  }
}
