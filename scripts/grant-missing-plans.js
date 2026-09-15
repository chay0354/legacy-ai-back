/**
 * Give every unpaid auth user an active plan.
 * The Archive if they own 0–1 archives; Family if they already own two or more.
 * Existing paid Stripe / credit rows are left alone.
 *
 * Usage: node scripts/grant-missing-plans.js
 */
import 'dotenv/config';
import { grantMissingPlans } from '../src/services/grantMissingPlans.js';

const result = await grantMissingPlans();
console.log(JSON.stringify({
  users: result.users,
  granted: result.granted,
  already: result.already,
  failed: result.failed,
  details: result.details,
}, null, 2));
if (result.failed) process.exit(1);
