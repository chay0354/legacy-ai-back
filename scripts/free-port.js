/**
 * Free the dev port before starting the server.
 *
 * Repeated `npm run dev` / editor restarts can leave an orphaned backend holding
 * the port, which crashes the next start with EADDRINUSE. This script finds and
 * kills whatever is listening on PORT (default 3001) so `npm run dev` is reliable.
 *
 * Cross-platform (Windows / macOS / Linux). Best-effort: never fails the start.
 */
import { execSync } from 'node:child_process';

const PORT = process.env.PORT || 3001;

function killPids(pids) {
  const unique = [...new Set(pids)].filter((p) => p && p !== String(process.pid));
  for (const pid of unique) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      else process.kill(Number(pid), 'SIGKILL');
      console.log(`[free-port] freed port ${PORT} (killed pid ${pid})`);
    } catch { /* already gone */ }
  }
}

try {
  if (process.platform === 'win32') {
    const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' });
    const pids = out
      .split(/\r?\n/)
      .filter((l) => l.includes(`:${PORT} `) && /LISTENING/i.test(l))
      .map((l) => l.trim().split(/\s+/).pop());
    killPids(pids);
  } else {
    const out = execSync(`lsof -ti tcp:${PORT} -s TCP:LISTEN || true`, { encoding: 'utf8', shell: '/bin/sh' });
    killPids(out.split(/\s+/).map((s) => s.trim()).filter(Boolean));
  }
} catch {
  // No matching process, or the lookup tool isn't available — starting is still fine.
}
