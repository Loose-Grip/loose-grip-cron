/**
 * syncUpcomingEvents.ts
 *
 * Fetches upcoming PDGA Elite Series (ES) and National Tour (NT) events from
 * the PDGA JSON API and upserts them into the events table.
 *
 * Skips events that are already in_progress or complete.
 * Runs once daily via GitHub Actions.
 */

import { withSession } from '../lib/pdga/auth';
import { supabase } from '../lib/supabase';
import { logRun } from '../lib/logger';
import axios from 'axios';

interface PdgaEventApiItem {
  tournament_id: string | number;
  tournament_name: string;
  city: string;
  state_prov: string;
  country: string;
  start_date: string;
  end_date: string;
  status: string;
  format: string;
  class: string;
  tier: string;
  last_modified: string;
}

interface PdgaEventListResponse {
  events: PdgaEventApiItem[];
}

async function main(): Promise<void> {
  const startMs = Date.now();

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
  const futureDate = new Date(today.getTime() + 180 * 24 * 60 * 60 * 1_000);
  const futureDateStr = futureDate.toISOString().split('T')[0];

  let insertedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  try {
    await withSession(async (session) => {
      const response = await axios.get<PdgaEventListResponse>(
        'https://api.pdga.com/services/json/event',
        {
          params: {
            tier: 'NT,ES',
            start_date: todayStr,
            end_date: futureDateStr,
            limit: 50,
          },
          headers: {
            Cookie: `${session.session_name}=${session.sessid}`,
          },
          timeout: 15_000,
        }
      );

      const rawEvents: PdgaEventApiItem[] = response.data?.events ?? [];
      console.log(`syncUpcomingEvents: PDGA API returned ${rawEvents.length} event(s)`);

      // Filter to eligible events
      const eligible = rawEvents.filter(
        (e) =>
          e.format === 'singles' &&
          e.class === 'Pro' &&
          ['NT', 'ES'].includes(e.tier) &&
          e.status === 'sanctioned'
      );

      console.log(`syncUpcomingEvents: ${eligible.length} eligible after filtering`);

      for (const event of eligible) {
        const pdgaEventId = String(event.tournament_id);

        // Check if this event already exists in a terminal/active state
        const { data: existing } = await supabase
          .from('events')
          .select('id, status, last_pdga_modified')
          .eq('pdga_event_id', pdgaEventId)
          .single();

        if (existing && (existing.status === 'complete' || existing.status === 'in_progress')) {
          skippedCount++;
          continue;
        }

        // Skip if data hasn't changed
        if (existing && existing.last_pdga_modified === event.last_modified) {
          skippedCount++;
          continue;
        }

        const location = [event.city, event.state_prov, event.country]
          .filter(Boolean)
          .join(', ');

        const row = {
          pdga_event_id: pdgaEventId,
          name: event.tournament_name,
          location,
          start_date: event.start_date,
          end_date: event.end_date,
          status: 'upcoming',
          last_pdga_modified: event.last_modified,
        };

        const { error } = await supabase
          .from('events')
          .upsert(row, { onConflict: 'pdga_event_id' });

        if (error) {
          console.error(`syncUpcomingEvents: upsert failed for ${pdgaEventId}:`, error.message);
        } else {
          if (existing) {
            updatedCount++;
          } else {
            insertedCount++;
          }
        }
      }
    });

    const msg = `inserted=${insertedCount} updated=${updatedCount} skipped=${skippedCount}`;
    console.log('syncUpcomingEvents: done —', msg);
    await logRun({ job: 'sync_events', status: 'success', message: msg, duration_ms: Date.now() - startMs });
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('syncUpcomingEvents: fatal error —', msg);
    await logRun({ job: 'sync_events', status: 'error', message: msg, duration_ms: Date.now() - startMs });
    process.exit(1);
  }
}

main();
