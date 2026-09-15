/** Customer plans. Amounts must match the Stripe Price objects. */
export const PLANS = {
  setup: {
    id: 'setup',
    name: 'Set up',
    cadence: 'one time · includes first 3 months',
    amount: 69900,
    currency: 'usd',
    interval: null,
    checkoutMode: 'payment',
    maxOwnedArchives: 20,
    monthsIncluded: 3,
    minutes: 180,
    canInterview: true,
    canViewArchive: true,
    public: true,
    primary: false,
    lines: [
      'Everything in Monthly, prepaid for three months',
      'Interview, archive, live avatar, and family access',
      '180 minutes included',
    ],
  },
  monthly: {
    id: 'monthly',
    name: 'Monthly',
    cadence: 'per month · 60 minutes',
    amount: 6990,
    currency: 'usd',
    interval: 'month',
    checkoutMode: 'subscription',
    maxOwnedArchives: 20,
    minutes: 60,
    canInterview: true,
    canViewArchive: true,
    public: true,
    primary: true,
    lines: [
      'Guided interview and a full archive you can read',
      'Live avatar and family invitations',
      '60 minutes each month',
    ],
  },
  preserve: {
    id: 'preserve',
    name: 'Preserve',
    cadence: 'one time · interview only',
    amount: 699,
    currency: 'usd',
    interval: null,
    checkoutMode: 'payment',
    maxOwnedArchives: 1,
    minutes: 0,
    canInterview: true,
    canViewArchive: false,
    public: true,
    primary: false,
    lines: [
      'Record the guided interview',
      'We keep what you share',
      'Pay Monthly or Set up when you want to see the archive',
    ],
  },
  addon: {
    id: 'addon',
    name: '30 min add',
    cadence: 'one time extra minutes',
    amount: 2999,
    currency: 'usd',
    interval: null,
    checkoutMode: 'payment',
    kind: 'addon',
    maxOwnedArchives: 0,
    minutes: 30,
    canInterview: false,
    canViewArchive: false,
    public: false,
    primary: false,
    lines: [
      'Add 30 minutes to an active Monthly or Set up plan',
    ],
  },
  /** Complimentary / older Stripe subscribers — full access, not sold on the site. */
  archive: {
    id: 'archive',
    name: 'The Archive',
    cadence: 'per month, one archive',
    amount: 1900,
    currency: 'usd',
    interval: 'month',
    checkoutMode: 'subscription',
    maxOwnedArchives: 1,
    minutes: 60,
    canInterview: true,
    canViewArchive: true,
    public: false,
    lines: [],
  },
  family: {
    id: 'family',
    name: 'Family',
    cadence: 'per month, more than one archive',
    amount: 3900,
    currency: 'usd',
    interval: 'month',
    checkoutMode: 'subscription',
    maxOwnedArchives: 20,
    minutes: 60,
    canInterview: true,
    canViewArchive: true,
    public: false,
    lines: [],
  },
};

export const PLAN_IDS = Object.keys(PLANS);
export const PUBLIC_PLAN_IDS = PLAN_IDS.filter((id) => PLANS[id].public);

const PRICE_ENV = {
  setup: 'STRIPE_PRICE_SETUP',
  monthly: 'STRIPE_PRICE_MONTHLY',
  preserve: 'STRIPE_PRICE_PRESERVE',
  addon: 'STRIPE_PRICE_ADDON',
  archive: 'STRIPE_PRICE_ARCHIVE',
  family: 'STRIPE_PRICE_FAMILY',
};

export function getPlan(id) {
  return PLANS[id] || null;
}

export function priceEnvName(planId) {
  return PRICE_ENV[planId] || PRICE_ENV.monthly;
}

export function priceIdForPlan(planId) {
  return process.env[priceEnvName(planId)] || '';
}

export function planIdFromPriceId(priceId) {
  if (!priceId) return null;
  for (const id of PLAN_IDS) {
    if (priceId === process.env[PRICE_ENV[id]]) return id;
  }
  return null;
}

export function checkoutPlanId(raw) {
  const id = String(raw || '').toLowerCase();
  if (getPlan(id) && id !== 'none') return id;
  return null;
}

export function isAddonPlan(id) {
  return getPlan(id)?.kind === 'addon';
}

export function planCanInterview(id) {
  return Boolean(getPlan(id)?.canInterview);
}

export function planCanViewArchive(id) {
  return Boolean(getPlan(id)?.canViewArchive);
}

/** Monthly and Set up spend the included minutes. Complimentary Archive/Family do not. */
export function planUsesMinutes(id) {
  return id === 'monthly' || id === 'setup';
}

export function addonOffer() {
  const p = PLANS.addon;
  return {
    id: p.id,
    name: p.name,
    displayPrice: formatMoney(p.amount, p.currency),
    minutes: p.minutes,
    amount: p.amount,
  };
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
  return PUBLIC_PLAN_IDS.map((id) => {
    const p = PLANS[id];
    return {
      id: p.id,
      name: p.name,
      cadence: p.cadence,
      amount: p.amount,
      currency: p.currency,
      interval: p.interval || 'once',
      displayPrice: formatMoney(p.amount, p.currency),
      lines: p.lines,
      primary: Boolean(p.primary),
      kind: p.kind || 'plan',
      canInterview: Boolean(p.canInterview),
      canViewArchive: Boolean(p.canViewArchive),
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
    return `$${(amountCents / 100).toFixed(2)}`;
  }
}

export function planDisplayName(id) {
  return getPlan(id)?.name || 'None';
}
