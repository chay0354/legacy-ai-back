import { createApp, ensureReady } from '../src/app.js';

let app;
let initPromise;

async function getApp() {
  if (!initPromise) {
    initPromise = ensureReady().then(() => {
      app = createApp();
      return app;
    });
  }
  return initPromise;
}

/** Vercel requires a default export that is a function (req, res) handler. */
export default async function handler(req, res) {
  const expressApp = await getApp();
  return expressApp(req, res);
}
