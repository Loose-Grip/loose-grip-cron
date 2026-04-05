/**
 * openDraft.ts
 *
 * Triggers the /api/cron/open-draft route in the main Next.js app.
 * All business logic lives there — this script is just the scheduled trigger.
 *
 * The endpoint finds events where status = 'upcoming' AND draft_opens_at <= now
 * AND draft_order is set, seeds draft_picks, and transitions them to draft_open.
 *
 * Exits early if the current time is outside 09:00–21:00 Melbourne.
 * Runs every 15 minutes via GitHub Actions.
 */

import axios from 'axios';
import { isInActiveWindow } from '../lib/draft/pickTimer';
import { logRun } from '../lib/logger';

async function main(): Promise<void> {
  const startMs = Date.now();

  if (!isInActiveWindow(new Date())) {
    console.log('openDraft: outside active window (09:00–21:00 Melbourne) — skipping');
    await logRun({ job: 'open_draft', status: 'skipped', message: 'Outside active window', duration_ms: Date.now() - startMs });
    process.exit(0);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const token = process.env.CRON_SERVICE_TOKEN;

  if (!appUrl || !token) {
    const msg = 'Missing NEXT_PUBLIC_APP_URL or CRON_SERVICE_TOKEN';
    console.error('openDraft:', msg);
    await logRun({ job: 'open_draft', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }

  try {
    const response = await axios.post(
      `${appUrl}/api/cron/open-draft`,
      {},
      {
        headers: { 'X-Service-Token': token },
        timeout: 30_000,
      }
    );

    const { opened, skipped } = response.data?.data ?? {};
    const msg = `HTTP ${response.status} — opened=${opened ?? '?'} skipped=${skipped ?? '?'}`;
    console.log('openDraft: success —', msg);
    await logRun({ job: 'open_draft', status: 'success', message: msg, duration_ms: Date.now() - startMs });
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('openDraft: error —', msg);
    await logRun({ job: 'open_draft', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }
}

main();
