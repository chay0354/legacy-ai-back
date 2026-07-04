import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from './middleware/auth.js';
import interviewRouter from './routes/interview.js';
import accessRouter, { previewInvite } from './routes/access.js';
import avatarRouter from './routes/avatar.js';
import authRouter from './routes/auth.js';
import { ensureSchema, getPool } from './db/pool.js';

function corsOrigins() {
  const origins = new Set([
    'http://localhost:5173',
    'http://localhost:3000',
  ]);

  for (const raw of [process.env.FRONTEND_URL, process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
    if (!raw) continue;
    if (raw.startsWith('http')) origins.add(raw.replace(/\/$/, ''));
    else origins.add(`https://${raw.replace(/\/$/, '')}`);
  }

  return [...origins];
}

function isAllowedOrigin(origin, allowed) {
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  return /^https:\/\/[\w.-]+\.vercel\.app$/.test(origin);
}

let initPromise = null;

/** One-time DB setup — safe to call on every serverless cold start. */
export async function ensureReady() {
  if (!initPromise) {
    initPromise = (async () => {
      if (!getPool()) return;
      try {
        await ensureSchema();
        console.log('Database ready (direct Postgres)');
      } catch (err) {
        console.error('Database setup failed:', err.message);
      }
    })();
  }
  return initPromise;
}

export function createApp() {
  const app = express();
  const allowed = corsOrigins();

  app.use(cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin, allowed));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '12mb' }));

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY,
  );

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      dbMode: getPool() ? 'postgres' : 'supabase-api',
      supabaseUrl: process.env.SUPABASE_URL,
    });
  });

  app.use('/api/auth', authRouter);

  app.get('/api/supabase-check', async (_req, res) => {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      res.json({ connected: true, session: data.session ? 'active' : 'none' });
    } catch (err) {
      res.status(500).json({ connected: false, error: err.message });
    }
  });

  app.use('/api/interview', requireAuth, interviewRouter);
  app.get('/api/access/invite/:token', previewInvite);
  app.use('/api/access', requireAuth, accessRouter);
  app.use('/api/avatar', requireAuth, avatarRouter);

  return app;
}

export const app = createApp();
