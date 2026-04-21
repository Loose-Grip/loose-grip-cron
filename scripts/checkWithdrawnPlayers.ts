/**
 * checkWithdrawnPlayers.ts
 *
 * For each upcoming or draft_open event where either:
 *   - draft_opens_at is within the next 24 hours (1-day pre-draft check), or
 *   - start_date is today UTC (morning-of check)
 *
 * 1. Scrape current registered MPO players from PDGA
 * 2. Call POST /api/cron/check-withdrawn-players with { event_id, registered_pdga_numbers: [...] }
 */

import axios from 'axios';
import { scrapeEventPlayers } from '../lib/scraper/pdgaEventPlayers';
import { supabase } from '../lib/supabase';
import { logRun } from '../lib/logger';

interface EventRow {
  id: string;
  pdga_event_id: string;
  name: string;
  draft_opens_at: string | null;
  start_date: string | null;
}

async function main(): Promise<void> {
  const startMs = Date.now();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const token = process.env.CRON_SERVICE_TOKEN;

  if (!appUrl || !token) {
    const msg = 'Missing NEXT_PUBLIC_APP_URL or CRON_SERVICE_TOKEN';
    console.error('checkWithdrawnPlayers:', msg);
    await logRun({ job: 'check_withdrawn', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }

  const { data: events, error: eventsError } = await supabase
    .from('events')
    .select('id, pdga_event_id, name, draft_opens_at, start_date')
    .in('status', ['upcoming', 'draft_open']);

  if (eventsError) {
    const msg = `Failed to query events: ${eventsError.message}`;
    console.error('checkWithdrawnPlayers:', msg);
    await logRun({ job: 'check_withdrawn', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }

  if (!events || events.length === 0) {
    console.log('checkWithdrawnPlayers: no upcoming/draft_open events — skipping');
    await logRun({ job: 'check_withdrawn', status: 'skipped', message: 'No eligible events', duration_ms: Date.now() - startMs });
    process.exit(0);
  }

  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const eligible = (events as EventRow[]).filter((ev) => {
    // Trigger 1: draft opens within the next 24 hours
    if (ev.draft_opens_at) {
      const draftOpens = new Date(ev.draft_opens_at);
      if (draftOpens > now && draftOpens <= in24h) return true;
    }
    // Trigger 2: event starts today (UTC date)
    if (ev.start_date && ev.start_date.slice(0, 10) === todayUtc) return true;
    return false;
  });

  if (eligible.length === 0) {
    console.log('checkWithdrawnPlayers: no events in trigger window — skipping');
    await logRun({ job: 'check_withdrawn', status: 'skipped', message: 'No events in trigger window', duration_ms: Date.now() - startMs });
    process.exit(0);
  }

  console.log(`checkWithdrawnPlayers: ${eligible.length} event(s) in trigger window`);

  const errors: string[] = [];
  const callbackUrl = `${appUrl.replace(/\/$/, '')}/api/cron/check-withdrawn-players`;

  for (const event of eligible) {
    const { id: eventId, pdga_event_id: pdgaEventId, name } = event;
    console.log(`checkWithdrawnPlayers: scraping players for "${name}" (${pdgaEventId})`);

    let players;
    try {
      players = await scrapeEventPlayers(pdgaEventId);
    } catch (err) {
      const msg = `scrapeEventPlayers failed for event ${pdgaEventId}: ${err instanceof Error ? err.message : err}`;
      console.error('checkWithdrawnPlayers:', msg);
      errors.push(msg);
      continue;
    }

    if (players.length === 0) {
      console.warn(`checkWithdrawnPlayers: no players scraped for event ${pdgaEventId} — skipping`);
      continue;
    }

    const registeredPdgaNumbers = players.map((p) => p.pdgaNumber);
    console.log(`checkWithdrawnPlayers: ${registeredPdgaNumbers.length} registered players for event ${pdgaEventId}`);

    try {
      const response = await axios.post(
        callbackUrl,
        { event_id: eventId, registered_pdga_numbers: registeredPdgaNumbers },
        { headers: { 'X-Service-Token': token }, timeout: 30_000 }
      );
      console.log(`checkWithdrawnPlayers: event ${pdgaEventId} → HTTP ${response.status}`);
    } catch (err) {
      const msg = `API call failed for event ${pdgaEventId}: ${err instanceof Error ? err.message : err}`;
      console.error('checkWithdrawnPlayers:', msg);
      errors.push(msg);
    }
  }

  const duration = Date.now() - startMs;

  if (errors.length > 0) {
    await logRun({
      job: 'check_withdrawn',
      status: 'error',
      message: errors.join('; '),
      duration_ms: duration,
    });
    process.exit(1);
  }

  await logRun({ job: 'check_withdrawn', status: 'success', message: null, duration_ms: duration });
  process.exit(0);
}

main();
