/**
 * checkEventCompletion.ts
 *
 * For each in-progress event, checks whether all rounds are complete by
 * comparing distinct (event_player_id, round_number) combinations against
 * the expected total: num_rounds × active_player_count.
 *
 * If complete AND scores_stale = false, calls the event completion endpoint
 * in the main Next.js app.
 */

import axios from 'axios';
import { supabase } from '../lib/supabase';
import { logRun } from '../lib/logger';

interface EventRow {
  id: string;
  pdga_event_id: string;
  num_rounds: number;
  scores_stale: boolean;
}

interface ScoreCountRow {
  event_player_id: string;
  round_number: number;
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
    .select('id, pdga_event_id, num_rounds, scores_stale')
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
    const { id: eventId, pdga_event_id: pdgaEventId, num_rounds: numRounds, scores_stale: scoresStale } = event;

    // Count distinct (event_player_id) to find active player count for this event
    const { data: playerCountData, error: playerCountError } = await supabase
      .from('event_players')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId);

    if (playerCountError) {
      const msg = `Failed to count players for event ${eventId}: ${playerCountError.message}`;
      console.error('checkEventCompletion:', msg);
      errors.push(msg);
      continue;
    }

    // Supabase returns count on the response object when head:true
    const { count: activePlayerCount } = await supabase
      .from('event_players')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', eventId);

    if (activePlayerCount === null) {
      const msg = `Could not determine player count for event ${eventId}`;
      console.warn('checkEventCompletion:', msg);
      errors.push(msg);
      continue;
    }

    const expectedScoreRows = numRounds * activePlayerCount;

    // Count distinct (event_player_id, round_number) score rows
    const { data: scoreRows, error: scoresError } = await supabase
      .from('scores')
      .select('event_player_id, round_number')
      .eq('event_id', eventId);

    if (scoresError) {
      const msg = `Failed to query scores for event ${eventId}: ${scoresError.message}`;
      console.error('checkEventCompletion:', msg);
      errors.push(msg);
      continue;
    }

    // Deduplicate by (event_player_id, round_number)
    const uniqueScores = new Set<string>(
      (scoreRows as ScoreCountRow[]).map((r) => `${r.event_player_id}:${r.round_number}`)
    );
    const actualScoreCount = uniqueScores.size;

    console.log(
      `checkEventCompletion: event ${pdgaEventId} — ${actualScoreCount}/${expectedScoreRows} score rows` +
        (scoresStale ? ' (scores_stale=true)' : '')
    );

    if (actualScoreCount < expectedScoreRows) {
      continue; // Not yet complete
    }

    if (scoresStale) {
      console.warn(
        `checkEventCompletion: event ${pdgaEventId} appears complete but scores_stale=true — skipping completion call`
      );
      continue;
    }

    // All rounds complete with verified data — trigger completion
    console.log(`checkEventCompletion: event ${pdgaEventId} is complete — triggering completion endpoint`);

    try {
      await axios.post(
        `${appUrl}/api/events/${eventId}/complete`,
        {},
        { headers: { 'X-Service-Token': token }, timeout: 30_000 }
      );
      console.log(`checkEventCompletion: completion triggered for event ${pdgaEventId}`);
    } catch (err) {
      const msg = `Completion endpoint failed for event ${pdgaEventId}: ${err instanceof Error ? err.message : err}`;
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
