import { app, ensureReady } from './app.js';
import { getPool } from './db/pool.js';

const port = process.env.PORT || 3001;
let server;

async function start() {
  await ensureReady();

  if (!process.env.SUPABASE_URL) {
    console.warn('SUPABASE_URL not set — API will fail until env vars are configured.');
  } else if (!getPool()) {
    console.warn('DATABASE_URL not set — using Supabase REST API.');
    console.warn('If you see "schema cache" errors, set DATABASE_URL or run supabase/migrations SQL in dashboard.');
  }

  server = app.listen(port, () => {
    console.log(`API running on http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Run "npm run dev" again (it auto-frees the port), or stop the other process.`);
      process.exit(1);
    }
    throw err;
  });
}

function shutdown() {
  if (server) {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
