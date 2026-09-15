/**
 * End-to-end check of the new-user flow:
 * sign up -> unpaid gates -> checkout session -> subscription -> paid gates.
 * Uses Stripe test mode and deletes the throwaway user at the end.
 */
import 'dotenv/config';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const API = process.env.TEST_API_URL || 'http://localhost:3001';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const email = `flow-test-${Date.now()}@example.com`;
const password = 'Test-passw0rd!';
const step = (n, s) => console.log(`\n${n}. ${s}`);

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Origin: 'http://localhost:5173',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

let userId = null;
try {
  step(1, 'Sign up a brand-new account');
  const signUp = await call('/api/auth/sign-up', {
    method: 'POST',
    body: { name: 'Flow Test', email, password },
  });
  console.log('   status', signUp.status, 'needsEmailConfirmation:', signUp.data?.needsEmailConfirmation ?? false);

  let token = signUp.data?.session?.access_token;
  userId = signUp.data?.user?.id;

  if (!token) {
    // Email confirmation is on — confirm via admin so the test can continue.
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const found = list.users.find((u) => u.email === email);
    userId = found?.id || userId;
    if (userId) await admin.auth.admin.updateUserById(userId, { email_confirm: true });
    const signIn = await call('/api/auth/sign-in', { method: 'POST', body: { email, password } });
    token = signIn.data?.session?.access_token;
    userId = signIn.data?.user?.id || userId;
    console.log('   confirmed + signed in:', signIn.status);
  }
  if (!token) throw new Error(`No session for the new user: ${JSON.stringify(signUp.data)}`);

  step(2, 'GET /api/access/me — billing should be unpaid');
  const me = await call('/api/access/me', { token });
  console.log('   status', me.status, 'billing:', JSON.stringify(me.data?.billing), 'memberships:', me.data?.memberships?.length);

  step(3, 'GET /api/interview/session — should be blocked with 402');
  const blocked = await call('/api/interview/session', { token });
  console.log('   status', blocked.status, 'code:', blocked.data?.code, '|', blocked.data?.error);

  step(4, 'POST /api/billing/checkout — should return a Stripe Checkout URL');
  const checkout = await call('/api/billing/checkout', { token, method: 'POST', body: { plan: 'archive' } });
  console.log('   status', checkout.status);
  console.log('   url:', String(checkout.data?.url || checkout.data?.error).slice(0, 80));
  if (checkout.data?.sessionId) {
    const cs = await stripe.checkout.sessions.retrieve(checkout.data.sessionId);
    console.log('   charges:', cs.currency?.toUpperCase(), (cs.amount_total ?? 0) / 100,
      '| adaptive pricing:', cs.adaptive_pricing?.enabled ?? 'n/a');
  }

  step(5, 'Simulate a completed payment (Stripe test subscription + webhook logic)');
  const sessionObj = await stripe.checkout.sessions.retrieve(checkout.data.sessionId);
  const customerId = sessionObj.customer;
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customerId });
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } });
  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: process.env.STRIPE_PRICE_ARCHIVE }],
    metadata: { userId, plan: 'archive' },
  });
  console.log('   subscription', sub.id, sub.status);

  const { applySubscriptionEvent } = await import('../src/services/stripeBilling.js');
  await applySubscriptionEvent({ admin, supabase: admin }, sub);
  console.log('   webhook applied');

  step(6, 'GET /api/billing/status — should now be paid');
  const status = await call('/api/billing/status', { token });
  console.log('   status', status.status, JSON.stringify(status.data));

  step(7, 'GET /api/interview/session — should now open');
  const session = await call('/api/interview/session', { token });
  console.log('   status', session.status, 'stage:', session.data?.stage, 'questions:', session.data?.questions?.length);

  step(8, 'GET /api/access/me — billing reflected for the app router');
  const me2 = await call('/api/access/me', { token });
  console.log('   billing:', JSON.stringify(me2.data?.billing), 'memberships:', me2.data?.memberships?.length);

  step(9, 'POST /api/billing/sync — what /billing/success calls on return');
  const synced = await call('/api/billing/sync', { token, method: 'POST', body: { sessionId: checkout.data.sessionId } });
  console.log('   status', synced.status, JSON.stringify(synced.data));

  step(10, 'POST /api/billing/portal — the Settings "manage billing" button');
  const portal = await call('/api/billing/portal', { token, method: 'POST' });
  console.log('   status', portal.status, String(portal.data?.url || portal.data?.error).slice(0, 60));

  step(11, 'Cancel the subscription — access must close again');
  const cancelled = await stripe.subscriptions.cancel(sub.id);
  await applySubscriptionEvent({ admin, supabase: admin }, cancelled);
  const afterCancel = await call('/api/billing/status', { token });
  console.log('   status', JSON.stringify(afterCancel.data));
  const gateAgain = await call('/api/interview/session', { token });
  console.log('   interview now:', gateAgain.status, gateAgain.data?.code || '');
} catch (err) {
  console.error('\nFLOW FAILED:', err.message);
  process.exitCode = 1;
} finally {
  if (userId) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    console.log('\ncleaned up test user');
  }
}
