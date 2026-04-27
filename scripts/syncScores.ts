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
import { fetchEventScores, scrapeAllRoundPars } from '../lib/scraper/pdgaScores';
import { logRun } from '../lib/logger';

interface EventRow {
  id: string;
  pdga_event_id: string;
  num_rounds: number;
  current_round: number;
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
    .select('id, pdga_event_id, num_rounds, current_round')
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
    const maxRounds = numRounds ?? 4;

    console.log(`syncScores: processing event ${pdgaEventId} (id=${eventId}) current_round=${event.current_round}`);

    // Resolve pdga_number → event_player_id once per event (shared across all rounds)
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

    const callbackUrl = `${appUrl.replace(/\/$/, '')}/api/cron/sync-scores`;

    // Scrape all rounds from 1 to current_round so previous rounds are backfilled
    // if their data was ever lost. Upsert is idempotent — no duplicates created.
    // Also attempt to scrape current_round+1 so we can detect when the next round
    // has started and auto-advance without relying on tee time scraping.
    const currentRound = event.current_round;
    const roundsToScrape = currentRound < maxRounds
      ? currentRound + 1   // include next round for auto-advance detection
      : currentRound;

    for (let roundToScrape = 1; roundToScrape <= roundsToScrape; roundToScrape++) {
      let scores: Awaited<ReturnType<typeof fetchEventScores>>;

      try {
        scores = await fetchEventScores(pdgaEventId, roundToScrape, maxRounds);
      } catch (err) {
        const msg = `fetchEventScores failed for event ${pdgaEventId} R${roundToScrape}: ${err instanceof Error ? err.message : err}`;
        console.error('syncScores:', msg);
        errors.push(msg);
        continue;
      }

      console.log(`syncScores: scraping R${roundToScrape} for event ${pdgaEventId} (${scores.length} scores)`);

      if (scores.length === 0) {
        console.warn(`syncScores: no scores for event ${pdgaEventId} R${roundToScrape} — skipping round`);
        continue;
      }

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
        console.warn(`syncScores: no resolvable players for event ${pdgaEventId} R${roundToScrape} — skipping`);
        continue;
      }

      // Cross-check: warn if scraper is about to overwrite a manual score with a different value.
      // This surfaces discrepancies (e.g. storm-suspension par awards vs official posted scores)
      // without blocking the upsert — official scraper scores always take precedence.
      const manualPlayerIds = upsertRows.map((r) => r.event_player_id);
      const { data: existingManual } = await supabase
        .from('scores')
        .select('event_player_id, strokes')
        .eq('event_id', eventId)
        .eq('round_number', roundToScrape)
        .eq('source', 'manual')
        .in('event_player_id', manualPlayerIds);

      for (const existing of existingManual ?? []) {
        const incoming = upsertRows.find((r) => r.event_player_id === existing.event_player_id);
        if (incoming && incoming.strokes !== existing.strokes) {
          console.warn(
            `syncScores: MANUAL SCORE OVERWRITE — event ${pdgaEventId} R${roundToScrape} ` +
            `player ${existing.event_player_id}: manual=${existing.strokes}, scraper=${incoming.strokes}`
          );
        }
      }

      const { error: upsertError } = await supabase
        .from('scores')
        .upsert(upsertRows, { onConflict: 'event_id,event_player_id,round_number' });

      if (upsertError) {
        const msg = `Upsert failed for event ${pdgaEventId} R${roundToScrape}: ${upsertError.message}`;
        console.error('syncScores:', msg);
        errors.push(msg);
        continue;
      }

      console.log(`syncScores: upserted ${upsertRows.length} score rows for event ${pdgaEventId} R${roundToScrape}`);

      // Trigger recalculation for this round.
      // is_verified=true when:
      //   (a) we've already advanced past this round (currentRound > roundToScrape), OR
      //   (b) this IS the final round and enough scores are present (round can't advance further).
      //
      // For the final round, "enough" = at least as many scores as there are event_players,
      // with a minimum floor of 10 (matches the auto-advance detection threshold).
      // We use the upsertRows count from this scrape as a proxy — if we just wrote a full
      // complement of scores for the last round, it's complete.
      const isFinalRound = roundToScrape === maxRounds;
      const finalRoundComplete = isFinalRound && upsertRows.length >= Math.max(10, playerMap.size);
      const isVerified = roundToScrape < currentRound || finalRoundComplete;
      try {
        await axios.post(
          callbackUrl,
          { event_id: eventId, round_number: roundToScrape, is_verified: isVerified },
          { headers: { 'X-Service-Token': token }, timeout: 30_000 }
        );
        console.log(`syncScores: triggered recalculation for event ${pdgaEventId} R${roundToScrape}`);
      } catch (err) {
        // Non-fatal — scores are in DB, recalculation retries next run
        console.warn(`syncScores: recalculation callback failed for event ${pdgaEventId} R${roundToScrape} (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
    }

    // Auto-advance: if we just scraped R(currentRound+1) and it has ≥10 scores,
    // the next round has clearly started — advance current_round.
    // Threshold of 10 matches the round-completion detection pattern used elsewhere.
    if (currentRound < maxRounds) {
      const nextRound = currentRound + 1;
      const { count } = await supabase
        .from('scores')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .eq('round_number', nextRound);
      if ((count ?? 0) >= 10) {
        await supabase
          .from('events')
          .update({ current_round: nextRound, next_round_starts_at: null })
          .eq('id', eventId);
        event.current_round = nextRound;
        console.log(`syncScores: auto-advanced to R${nextRound} (${count} scores found)`);
      }
    }

    // Scrape and upsert course_par into event_rounds for all completed rounds
    const roundPars = await scrapeAllRoundPars(pdgaEventId, maxRounds);
    for (const [rn, par] of roundPars) {
      const { error: parError } = await supabase.from('event_rounds').upsert(
        {
          event_id: eventId,
          round_number: rn,
          course_par: par,
          course_name: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'event_id,round_number' }
      );
      if (parError) {
        console.error(`syncScores: event_rounds upsert failed for event ${pdgaEventId} R${rn}: ${parError.message}`);
      }
    }
    if (roundPars.size > 0) {
      console.log(`syncScores: upserted course_par for ${roundPars.size} round(s) in event ${pdgaEventId}`);
    }

    // Mark event as fresh after all rounds processed
    await supabase.from('events').update({ scores_stale: false }).eq('id', eventId);
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
