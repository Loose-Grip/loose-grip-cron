/**
 * checkEventCompletion.ts
 *
 * For each in-progress event, auto-completes the event once
 * end_date + 36 hours has passed and all rounds have at least one score row.
 *
 * The 36-hour buffer gives participants time to see the final leaderboard
 * on the active event card before it moves to the "Past events" archive.
 *
 * Calls POST /api/cron/complete-event (service-token protected).
 */

import axios from 'axios';
import { supabase } from '../lib/supabase';
import { logRun } from '../lib/logger';

const COMPLETE_AFTER_HOURS = 36;

interface EventRow {
  id: string;
  pdga_event_id: string;
  num_rounds: number;
  end_date: string | null;
  scores_stale: boolean;
}

async function main(): Promise<void> {
  const startMs = Date.now();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const token = process.env.CRON_SERVICE_TOKEN;

  if (!appUrl || !token) {
    const msg = 'Missing NEXT_PUBLIC_APP_URL or CRON_SERVICE_TOKEN';
    console.error('checkEventCompletion:', msg);
    await logRun({ job: 'check_completion', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }

  const { data: events, error: eventsError } = await supabase
    .from('events')
    .select('id, pdga_event_id, num_rounds, end_date, scores_stale')
    .eq('status', 'in_progress');

  if (eventsError) {
    const msg = `Failed to query events: ${eventsError.message}`;
    console.error('checkEventCompletion:', msg);
    await logRun({ job: 'check_completion', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }

  if (!events || events.length === 0) {
    console.log('checkEventCompletion: no in-progress events — skipping');
    await logRun({ job: 'check_completion', status: 'skipped', message: 'No in-progress events', duration_ms: Date.now() - startMs });
    process.exit(0);
  }

  const errors: string[] = [];

  for (const event of events as EventRow[]) {
    const { id: eventId, pdga_event_id: pdgaEventId, num_rounds: numRounds, end_date: endDate, scores_stale: scoresStale } = event;

    // Gate 1: end_date must be set and 36h must have passed
    if (!endDate) {
      console.log(`checkEventCompletion: event ${pdgaEventId} has no end_date — skipping`);
      continue;
    }

    const completionThreshold = new Date(endDate).getTime() + COMPLETE_AFTER_HOURS * 60 * 60 * 1000;
    if (Date.now() < completionThreshold) {
      const hoursRemaining = ((completionThreshold - Date.now()) / 3_600_000).toFixed(1);
      console.log(`checkEventCompletion: event ${pdgaEventId} — ${hoursRemaining}h until auto-complete window`);
      continue;
    }

    // Gate 2: all rounds must have at least one score row
    const { data: scoredRoundRows } = await supabase
      .from('scores')
      .select('round_number')
      .eq('event_id', eventId);

    const uniqueScoredRounds = new Set((scoredRoundRows ?? []).map((r) => r.round_number));
    if (uniqueScoredRounds.size < numRounds) {
      const msg = `event ${pdgaEventId} — only ${uniqueScoredRounds.size}/${numRounds} rounds have scores after 36h; manual review required`;
      console.warn('checkEventCompletion:', msg);
      errors.push(msg);
      continue;
    }

    // Gate 3: scores must not be stale
    if (scoresStale) {
      console.warn(`checkEventCompletion: event ${pdgaEventId} — scores_stale=true after 36h; skipping until fresh`);
      continue;
    }

    console.log(`checkEventCompletion: event ${pdgaEventId} — 36h elapsed, all rounds scored — triggering auto-complete`);

    try {
      await axios.post(
        `${appUrl.replace(/\/$/, '')}/api/cron/complete-event`,
        { event_id: eventId },
        { headers: { 'X-Service-Token': token }, timeout: 30_000 }
      );
      console.log(`checkEventCompletion: auto-completed event ${pdgaEventId}`);
    } catch (err) {
      const msg = `Auto-complete failed for event ${pdgaEventId}: ${err instanceof Error ? err.message : err}`;
      console.error('checkEventCompletion:', msg);
      errors.push(msg);
    }
  }

  const duration = Date.now() - startMs;

  if (errors.length > 0) {
    await logRun({
      job: 'check_completion',
      status: 'error',
      message: errors.join('; '),
      duration_ms: duration,
    });
    process.exit(1);
  }

  await logRun({ job: 'check_completion', status: 'success', message: null, duration_ms: duration });
  process.exit(0);
}

main();
