/**
 * syncScores.ts
 *
 * For each in-progress event:
 *   1. Fetch scores from PDGA (Layer 2 XHR → Layer 3 HTML fallback)
 *   2. Upsert into the scores table
 *   3. Trigger /api/cron/sync-scores to recalculate standings
 */

import axios from 'axios';
import { supabase } from '../lib/supabase';
import { fetchEventScores } from '../lib/scraper/pdgaScores';
import { logRun } from '../lib/logger';

interface EventRow {
  id: string;
  pdga_event_id: string;
  num_rounds: number;
}

interface EventPlayerRow {
  id: string;
  pdga_number: string;
}

async function main(): Promise<void> {
  const startMs = Date.now();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const token = process.env.CRON_SERVICE_TOKEN;

  if (!appUrl || !token) {
    const msg = 'Missing NEXT_PUBLIC_APP_URL or CRON_SERVICE_TOKEN';
    console.error('syncScores:', msg);
    await logRun({ job: 'sync_scores', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }

  // Fetch in-progress events
  const { data: events, error: eventsError } = await supabase
    .from('events')
    .select('id, pdga_event_id, num_rounds')
    .eq('status', 'in_progress');

  if (eventsError) {
    const msg = `Failed to query events: ${eventsError.message}`;
    console.error('syncScores:', msg);
    await logRun({ job: 'sync_scores', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }

  if (!events || events.length === 0) {
    console.log('syncScores: no in-progress events — skipping');
    await logRun({ job: 'sync_scores', status: 'skipped', message: 'No in-progress events', duration_ms: Date.now() - startMs });
    process.exit(0);
  }

  console.log(`syncScores: found ${events.length} in-progress event(s)`);

  const errors: string[] = [];

  for (const event of events as EventRow[]) {
    const { id: eventId, pdga_event_id: pdgaEventId, num_rounds: numRounds } = event;

    // Derive current round from highest round already in scores table (or 1 if none)
    const { data: latestScore } = await supabase
      .from('scores')
      .select('round_number')
      .eq('event_id', eventId)
      .order('round_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    const currentRound = Math.min((latestScore?.round_number ?? 0) + 1, numRounds ?? 4);

    console.log(`syncScores: processing event ${pdgaEventId} (id=${eventId}) round ${currentRound}`);

    // Fetch scores from PDGA
    let scores;
    try {
      scores = await fetchEventScores(pdgaEventId, currentRound);
    } catch (err) {
      const msg = `fetchEventScores failed for event ${pdgaEventId}: ${err instanceof Error ? err.message : err}`;
      console.error('syncScores:', msg);
      errors.push(msg);

      await supabase.from('events').update({ scores_stale: true }).eq('id', eventId);
      continue;
    }

    if (scores.length === 0) {
      const msg = `No scores returned for event ${pdgaEventId} R${currentRound}`;
      console.warn('syncScores:', msg);
      errors.push(msg);
      await supabase.from('events').update({ scores_stale: true }).eq('id', eventId);
      continue;
    }

    // Resolve pdga_number → event_player_id for this event
    const { data: eventPlayers, error: epError } = await supabase
      .from('event_players')
      .select('id, pdga_number')
      .eq('event_id', eventId);

    if (epError) {
      const msg = `Failed to query event_players for event ${eventId}: ${epError.message}`;
      console.error('syncScores:', msg);
      errors.push(msg);
      await supabase.from('events').update({ scores_stale: true }).eq('id', eventId);
      continue;
    }

    const playerMap = new Map<string, string>(
      (eventPlayers as EventPlayerRow[]).map((p) => [p.pdga_number, p.id])
    );

    // Build upsert rows
    const upsertRows = scores
      .map((s) => {
        const eventPlayerId = playerMap.get(s.pdgaNumber);
        if (!eventPlayerId) {
          console.warn(`syncScores: no event_player found for PDGA #${s.pdgaNumber} in event ${eventId}`);
          return null;
        }
        return {
          event_id: eventId,
          event_player_id: eventPlayerId,
          round_number: s.roundNumber,
          strokes: s.strokes,
          source: 'scraper',
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (upsertRows.length === 0) {
      const msg = `No resolvable players for scores in event ${pdgaEventId}`;
      console.warn('syncScores:', msg);
      errors.push(msg);
      await supabase.from('events').update({ scores_stale: true }).eq('id', eventId);
      continue;
    }

    const { error: upsertError } = await supabase
      .from('scores')
      .upsert(upsertRows, { onConflict: 'event_id,event_player_id,round_number' });

    if (upsertError) {
      const msg = `Upsert failed for event ${pdgaEventId}: ${upsertError.message}`;
      console.error('syncScores:', msg);
      errors.push(msg);
      await supabase.from('events').update({ scores_stale: true }).eq('id', eventId);
      continue;
    }

    // Mark scores as fresh
    await supabase.from('events').update({ scores_stale: false }).eq('id', eventId);
    console.log(`syncScores: upserted ${upsertRows.length} score rows for event ${pdgaEventId}`);

    // Trigger recalculation
    const callbackUrl = `${appUrl.replace(/\/$/, '')}/api/cron/sync-scores`;
    console.log(`syncScores: calling recalculate at ${callbackUrl}`);
    try {
      await axios.post(
        callbackUrl,
        { event_id: eventId, round_number: currentRound },
        { headers: { 'X-Service-Token': token }, timeout: 30_000 }
      );
      console.log(`syncScores: triggered sync-scores callback for event ${pdgaEventId}`);
    } catch (err) {
      // Non-fatal — scores are already in DB, recalculation can retry next run
      console.warn(`syncScores: sync-scores callback failed for event ${pdgaEventId} (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  const duration = Date.now() - startMs;

  if (errors.length > 0) {
    await logRun({
      job: 'sync_scores',
      status: 'error',
      message: errors.join('; '),
      duration_ms: duration,
    });
    process.exit(1);
  }

  await logRun({ job: 'sync_scores', status: 'success', message: null, duration_ms: duration });
  process.exit(0);
}

main();
