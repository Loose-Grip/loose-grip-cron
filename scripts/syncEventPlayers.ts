/**
 * syncEventPlayers.ts
 *
 * For each event with status 'upcoming' or 'draft_open':
 *   1. Scrape the MPO player list from the PDGA event page
 *   2. Enrich with rating + nationality from the PDGA API
 *   3. Upsert into event_players
 */

import { withSession } from '../lib/pdga/auth';
import { scrapeEventPlayers } from '../lib/scraper/pdgaEventPlayers';
import { supabase } from '../lib/supabase';
import { logRun } from '../lib/logger';

interface EventRow {
  id: string;
  pdga_event_id: string;
  name: string;
}

async function main(): Promise<void> {
  const startMs = Date.now();

  // Fetch events that need player lists
  const { data: events, error: eventsError } = await supabase
    .from('events')
    .select('id, pdga_event_id, name')
    .in('status', ['upcoming', 'draft_open']);

  if (eventsError) {
    const msg = `Failed to query events: ${eventsError.message}`;
    console.error('syncEventPlayers:', msg);
    await logRun({ job: 'sync_players', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }

  if (!events || events.length === 0) {
    console.log('syncEventPlayers: no upcoming/draft_open events — skipping');
    await logRun({ job: 'sync_players', status: 'skipped', message: 'No eligible events', duration_ms: Date.now() - startMs });
    process.exit(0);
  }

  console.log(`syncEventPlayers: found ${events.length} event(s) to process`);

  const errors: string[] = [];
  let totalPlayers = 0;

  try {
    await withSession(async (session) => {
      for (const event of events as EventRow[]) {
        const { id: eventId, pdga_event_id: pdgaEventId, name } = event;
        console.log(`syncEventPlayers: scraping players for "${name}" (${pdgaEventId})`);

        let players;
        try {
          players = await scrapeEventPlayers(pdgaEventId, session);
        } catch (err) {
          const msg = `scrapeEventPlayers failed for event ${pdgaEventId}: ${err instanceof Error ? err.message : err}`;
          console.error('syncEventPlayers:', msg);
          errors.push(msg);
          continue;
        }

        if (players.length === 0) {
          console.warn(`syncEventPlayers: no players scraped for event ${pdgaEventId}`);
          continue;
        }

        const upsertRows = players.map((p) => ({
          event_id: eventId,
          pdga_number: p.pdgaNumber,
          name: p.name,
          pdga_rating: p.pdgaRating,
          nationality: p.nationality,
        }));

        const { error: upsertError } = await supabase
          .from('event_players')
          .upsert(upsertRows, { onConflict: 'event_id,pdga_number' });

        if (upsertError) {
          const msg = `Upsert failed for event ${pdgaEventId}: ${upsertError.message}`;
          console.error('syncEventPlayers:', msg);
          errors.push(msg);
          continue;
        }

        totalPlayers += players.length;
        console.log(`syncEventPlayers: upserted ${players.length} players for event ${pdgaEventId}`);
      }
    });
  } catch (err) {
    const msg = `PDGA session error: ${err instanceof Error ? err.message : String(err)}`;
    console.error('syncEventPlayers:', msg);
    await logRun({ job: 'sync_players', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }

  const duration = Date.now() - startMs;

  if (errors.length > 0) {
    await logRun({
      job: 'sync_players',
      status: 'error',
      message: errors.join('; '),
      duration_ms: duration,
    });
    process.exit(1);
  }

  const msg = `total_players=${totalPlayers} across ${events.length} event(s)`;
  await logRun({ job: 'sync_players', status: 'success', message: msg, duration_ms: duration });
  process.exit(0);
}

main();
