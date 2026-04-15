/**
 * syncUpcomingEvents.ts
 *
 * Scrapes upcoming PDGA Elite Series (ES) and National Tour (NT) events from
 * the public PDGA tour search page (no auth required) and upserts them into
 * the events table.
 *
 * Skips events that are already in_progress, draft_open, or complete.
 * Runs once daily via GitHub Actions.
 */

import * as cheerio from 'cheerio';
import { fetchWithRetry } from '../lib/scraper/rateLimiter';
import { supabase } from '../lib/supabase';
import { logRun } from '../lib/logger';

interface ScrapedEvent {
  pdgaEventId: string;
  tier: string;
  name: string;
  location: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

const MONTH_MAP: Record<string, string> = {
  January: '01', February: '02', March: '03', April: '04',
  May: '05', June: '06', July: '07', August: '08',
  September: '09', October: '10', November: '11', December: '12',
};

/**
 * Parses PDGA date strings into YYYY-MM-DD.
 * Formats seen on the page:
 *   "April 17 - 19, 2026"         → start: 2026-04-17, end: 2026-04-19
 *   "April 30 - May 3, 2026"      → start: 2026-04-30, end: 2026-05-03
 *   "December 31, 2026 - January 2, 2027" → cross-year
 */
function parseDateRange(raw: string): { startDate: string; endDate: string } | null {
  // Normalise whitespace
  const s = raw.replace(/\s+/g, ' ').trim();

  // Pattern: "Month D - D, YYYY"  (same month)
  const sameMonth = s.match(/^(\w+)\s+(\d+)\s*-\s*(\d+),\s*(\d{4})$/);
  if (sameMonth) {
    const [, month, d1, d2, year] = sameMonth;
    const m = MONTH_MAP[month];
    if (!m) return null;
    return {
      startDate: `${year}-${m}-${d1.padStart(2, '0')}`,
      endDate: `${year}-${m}-${d2.padStart(2, '0')}`,
    };
  }

  // Pattern: "Month D - Month D, YYYY"  (different months, same year)
  const diffMonth = s.match(/^(\w+)\s+(\d+)\s*-\s*(\w+)\s+(\d+),\s*(\d{4})$/);
  if (diffMonth) {
    const [, m1, d1, m2, d2, year] = diffMonth;
    const mm1 = MONTH_MAP[m1];
    const mm2 = MONTH_MAP[m2];
    if (!mm1 || !mm2) return null;
    return {
      startDate: `${year}-${mm1}-${d1.padStart(2, '0')}`,
      endDate: `${year}-${mm2}-${d2.padStart(2, '0')}`,
    };
  }

  // Pattern: "Month D, YYYY - Month D, YYYY"  (cross-year)
  const crossYear = s.match(/^(\w+)\s+(\d+),\s*(\d{4})\s*-\s*(\w+)\s+(\d+),\s*(\d{4})$/);
  if (crossYear) {
    const [, m1, d1, y1, m2, d2, y2] = crossYear;
    const mm1 = MONTH_MAP[m1];
    const mm2 = MONTH_MAP[m2];
    if (!mm1 || !mm2) return null;
    return {
      startDate: `${y1}-${mm1}-${d1.padStart(2, '0')}`,
      endDate: `${y2}-${mm2}-${d2.padStart(2, '0')}`,
    };
  }

  return null;
}

async function scrapeEvents(): Promise<ScrapedEvent[]> {
  // Capitalised Tier[] and Classification[] are required by the PDGA search form
  const url =
    'https://www.pdga.com/tour/search' +
    '?Tier%5B%5D=NT&Tier%5B%5D=ES&Tier%5B%5D=M' +
    '&status=sanctioned' +
    '&Classification%5B%5D=Pro';

  const html = await fetchWithRetry(url);
  const $ = cheerio.load(html);

  const events: ScrapedEvent[] = [];

  $('table.views-table tbody tr').each((_, row) => {
    const $row = $(row);
    const classes = $row.attr('class') ?? '';

    // Extract tournament ID from the row class: "... tid-96404 ..."
    const tidMatch = classes.match(/tid-(\d+)/);
    if (!tidMatch) return;
    const pdgaEventId = tidMatch[1];

    // Extract tier from row class: "... tier-ES ..."
    const tierMatch = classes.match(/tier-([A-Z]+)/);
    if (!tierMatch) return;
    const tier = tierMatch[1];

    // Only NT, ES, and M (Majors)
    if (!['NT', 'ES', 'M'].includes(tier)) return;

    const name = $row.find('td.views-field-OfficialName a').text().trim();
    if (!name) return;

    const location = $row.find('td.views-field-Location').text().trim();
    const rawDate = $row.find('td.views-field-StartDate').text().trim();

    const dates = parseDateRange(rawDate);
    if (!dates) {
      console.warn(`syncUpcomingEvents: could not parse date "${rawDate}" for event ${pdgaEventId} — skipping`);
      return;
    }

    events.push({
      pdgaEventId,
      tier,
      name,
      location,
      startDate: dates.startDate,
      endDate: dates.endDate,
    });
  });

  return events;
}

async function main(): Promise<void> {
  const startMs = Date.now();

  let insertedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  try {
    // Look up the active season
    const { data: season, error: seasonError } = await supabase
      .from('seasons')
      .select('id')
      .eq('is_active', true)
      .single();

    if (seasonError || !season) {
      const msg = 'No active season found — create a season first';
      console.error('syncUpcomingEvents:', msg);
      await logRun({ job: 'sync_events', status: 'error', message: msg, duration_ms: Date.now() - startMs });
      process.exit(1);
    }

    const scraped = await scrapeEvents();
    console.log(`syncUpcomingEvents: scraped ${scraped.length} NT/ES event(s)`);

    for (const event of scraped) {
      // Check if this event already exists in a terminal/active state
      const { data: existing } = await supabase
        .from('events')
        .select('id, status')
        .eq('pdga_event_id', event.pdgaEventId)
        .single();

      if (existing && ['complete', 'in_progress', 'draft_open'].includes(existing.status)) {
        skippedCount++;
        continue;
      }

      const row = {
        season_id: season.id,
        pdga_event_id: event.pdgaEventId,
        name: event.name,
        location: event.location,
        start_date: event.startDate,
        end_date: event.endDate,
        status: 'upcoming',
      };

      const { error } = await supabase
        .from('events')
        .upsert(row, { onConflict: 'pdga_event_id' });

      if (error) {
        console.error(`syncUpcomingEvents: upsert failed for ${event.pdgaEventId}:`, error.message);
      } else {
        if (existing) {
          updatedCount++;
        } else {
          insertedCount++;
        }
      }
    }

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

