import { Router } from 'express';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { getPlan, PLAN_IDS, priceIdForPlan, publicPlans } from '../services/plans.js';
import {
  applyCheckoutSession,
  applySubscriptionEvent,
  billingForUser,
  publicBilling,
  rememberCustomer,
  stripeClient,
  stripeConfigured,
  syncCheckoutSession,
} from '../services/stripeBilling.js';
import { getBillingByUserId } from '../db/billingRepo.js';

const router = Router();

function frontendBase(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  if (origin && /^https:\/\/[\w.-]+\.vercel\.app$/.test(origin)) return origin;
  return String(process.env.FRONTEND_URL || 'https://legacy-ai-front.vercel.app').replace(/\/$/, '');
}

function serviceReq() {
  const key = process.env.SUPABASE_SECRET_KEY;
  const admin = key
    ? createClient(process.env.SUPABASE_URL, key, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;
  return { admin, supabase: admin };
}

export function billingWebhookHandler() {
  return [
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) return res.status(503).json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' });
      const stripe = stripeClient();
      const sig = req.headers['stripe-signature'];
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
      } catch (err) {
        console.warn('[billing] webhook signature failed:', err.message);
        return res.status(400).json({ error: 'Invalid signature' });
      }

      const ctx = serviceReq();
      try {
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          if (session.mode === 'subscription') await applyCheckoutSession(ctx, session);
        } else if (
          event.type === 'customer.subscription.updated'
          || event.type === 'customer.subscription.deleted'
          || event.type === 'customer.subscription.created'
        ) {
          await applySubscriptionEvent(ctx, event.data.object);
        } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
          const invoice = event.data.object;
          const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
          if (subId) {
            const subscription = await stripe.subscriptions.retrieve(subId);
            await applySubscriptionEvent(ctx, subscription);
          }
        }
      } catch (err) {
        console.error('[billing] webhook handler failed:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json({ received: true });
    },
  ];
}

router.get('/plans', (_req, res) => {
  res.json({
    plans: publicPlans(),
    configured: stripeConfigured(),
  });
});

router.get('/status', async (req, res) => {
  try {
    const row = await getBillingByUserId(req, req.user.id);
    res.json(publicBilling(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/checkout', async (req, res) => {
  try {
    if (!stripeConfigured()) return res.status(503).json({ error: 'Billing is not configured yet.' });
    const planId = req.body?.plan === 'family' ? 'family' : 'archive';
    const priceId = priceIdForPlan(planId);
    if (!priceId) return res.status(503).json({ error: `Missing Stripe price for ${planId}` });

    const stripe = stripeClient();
    const existing = await getBillingByUserId(req, req.user.id);
    let customerId = existing?.stripeCustomerId || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.userEmail || undefined,
        name: req.user.user_metadata?.full_name || undefined,
        metadata: { userId: req.user.id },
      });
      customerId = customer.id;
      await rememberCustomer(req, req.user.id, customerId);
    }

    const front = frontendBase(req);
    const params = {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: req.user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${front}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${front}/pricing`,
      allow_promotion_codes: true,
      metadata: { userId: req.user.id, plan: planId },
      subscription_data: {
        metadata: { userId: req.user.id, plan: planId },
      },
      // The site quotes USD, so Checkout must charge USD rather than a converted local amount.
      adaptive_pricing: { enabled: false },
    };

    let session;
    try {
      session = await stripe.checkout.sessions.create(params);
    } catch (err) {
      if (!/adaptive_pricing/i.test(err.message)) throw err;
      delete params.adaptive_pricing;
      session = await stripe.checkout.sessions.create(params);
    }

    res.json({ url: session.url, sessionId: session.id, plan: planId });
  } catch (err) {
    console.error('[billing] checkout failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/portal', async (req, res) => {
  try {
    if (!stripeConfigured()) return res.status(503).json({ error: 'Billing is not configured yet.' });
    const existing = await getBillingByUserId(req, req.user.id);
    if (!existing?.stripeCustomerId) {
      return res.status(400).json({ error: 'No billing customer yet — choose a plan first.' });
    }
    const session = await stripeClient().billingPortal.sessions.create({
      customer: existing.stripeCustomerId,
      return_url: `${frontendBase(req)}/settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** After Checkout redirect — write paid access even if the webhook is late. */
router.post('/sync', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const billing = await syncCheckoutSession(req, sessionId, req.user.id);
    res.json(billing);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

export function toPaymentError(res, err) {
  const status = err.status || 500;
  return res.status(status).json({ error: err.message, code: err.code });
}

export { PLAN_IDS, getPlan };

export default router;
