/**
 * checkPickTimers.ts
 *
 * Triggers the /api/cron/check-pick-timers route in the main Next.js app.
 * All business logic lives there — this script is just the scheduled trigger.
 *
 * Exits early if the current time is outside 09:00–21:00 Melbourne.
 * Runs every 5 minutes via GitHub Actions; the early-exit keeps PDGA/DB
 * traffic contained to the active window.
 */

import axios from 'axios';
import { isInActiveWindow } from '../lib/draft/pickTimer';
import { logRun } from '../lib/logger';

async function main(): Promise<void> {
  const startMs = Date.now();

  if (!isInActiveWindow(new Date())) {
    console.log('checkPickTimers: outside active window (09:00–21:00 Melbourne) — skipping');
    await logRun({ job: 'check_timers', status: 'skipped', message: 'Outside active window', duration_ms: Date.now() - startMs });
    process.exit(0);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const token = process.env.CRON_SERVICE_TOKEN;

  if (!appUrl || !token) {
    const msg = 'Missing NEXT_PUBLIC_APP_URL or CRON_SERVICE_TOKEN';
    console.error('checkPickTimers:', msg);
    await logRun({ job: 'check_timers', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }

  try {
    const response = await axios.post(
      `${appUrl}/api/cron/check-pick-timers`,
      {},
      {
        headers: { 'X-Service-Token': token },
        timeout: 30_000,
      }
    );

    const msg = `HTTP ${response.status}`;
    console.log('checkPickTimers: success —', msg);
    await logRun({ job: 'check_timers', status: 'success', message: msg, duration_ms: Date.now() - startMs });
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('checkPickTimers: error —', msg);
    await logRun({ job: 'check_timers', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }
}

main();
