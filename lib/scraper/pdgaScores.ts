/**
 * Score fetching — two layers tried in order:
 *
 *   Layer 2 (primary):  PDGA live scores page (pdga.com/live/event/{id}/MPO/scores?round={n})
 *   Layer 3 (fallback): Cheerio scrape of the main event results table
 *
 * Both layers verified against real PDGA event pages.
 *
 * Table structure (verified against https://www.pdga.com/tour/event/97336):
 *
 *   MPO section: <details><summary><h3 class="division" id="MPO">...</h3></summary>
 *   Player row:
 *     <td class="pdga-number">75412</td>
 *     <td class="round"><a href="/live/event/97336/MPO/scores?round=1" class="score">60</a></td>  ← absolute strokes
 *     <td class="round"><a href="/live/event/97336/MPO/scores?round=2" class="score">3:20 pm</a></td>  ← tee time (round not started)
 *     ...
 *
 * Tee time detection:
 *   When a round hasn't started, td.round a.score contains a time string (e.g. "3:00 pm")
 *   instead of a stroke count. fetchNextRoundTeeTimes() scrapes these and returns the
 *   latest as a UTC Date for round-start detection.
 */

import * as cheerio from 'cheerio';
import { fetchWithRetry } from './rateLimiter';

export interface ScrapedScore {
  pdgaNumber: string;
  roundNumber: number;
  strokes: number;
}

// ---------------------------------------------------------------------------
// Layer 3 — Cheerio scrape of the main event results table (fallback)
// ---------------------------------------------------------------------------

/**
 * Scrapes round scores from the main event page results table.
 *
 * Verified structure:
 *   - MPO section identified by <h3 class="division" id="MPO"> inside <details>
 *   - Player PDGA number: td.pdga-number
 *   - Round scores: td.round > a.score (link text = strokes for that round)
 *   - Round number extracted from href: /live/event/{id}/MPO/scores?round={n}
 *   - Rounds not yet played have no link, or the cell is absent
 */
async function scrapeHtmlScores(
  pdgaEventId: string,
  roundNumber: number
): Promise<ScrapedScore[]> {
  const url = `https://www.pdga.com/tour/event/${encodeURIComponent(pdgaEventId)}`;
  const html = await fetchWithRetry(url);
  const $ = cheerio.load(html);

  const results: ScrapedScore[] = [];

  // Find the MPO division block
  const $mpoHeading = $('h3.division#MPO');
  if ($mpoHeading.length === 0) {
    console.warn(`Layer 3: no MPO division found for event ${pdgaEventId}`);
    return [];
  }

  const $details = $mpoHeading.closest('details');
  const $table = $details.find('table');

  $table.find('tbody tr').each((_, row) => {
    const $row = $(row);
    const pdgaNumber = $row.find('td.pdga-number').text().trim();
    if (!pdgaNumber) return;

    // Find the round cell matching our target round number
    // Each td.round contains an <a> with href including ?round={n}
    $row.find('td.round a.score').each((_, link) => {
      const href = $(link).attr('href') ?? '';
      const roundMatch = href.match(/[?&]round=(\d+)/);
      if (!roundMatch) return;
      if (parseInt(roundMatch[1], 10) !== roundNumber) return;

      const text = $(link).text().trim();
      // Rd1/Rd2 cells contain absolute stroke counts — pure positive integers (e.g. "60", "65").
      // Reject tee times like "9:13 am": parseInt("9:13 am") = 9, so must use regex not parseInt.
      if (!/^\d+$/.test(text)) return;
      const strokes = parseInt(text, 10);

      results.push({ pdgaNumber, roundNumber, strokes });
    });
  });

  if (results.length === 0) {
    console.warn(
      `Layer 3: no scores found for event ${pdgaEventId} R${roundNumber}. ` +
      'Round may not have started yet, or selectors need updating.'
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tee time scraping — detects when next round has started
// ---------------------------------------------------------------------------

/**
 * Scrapes tee times for a given round from the main event results table.
 * Returns the latest tee time as a UTC Date, or null if no tee times found
 * (meaning the round has already started and cells contain stroke counts instead).
 *
 * Tee time format on PDGA: "3:00 pm" or "9:13 am" (event local time, no date).
 * eventTimezone: IANA timezone string e.g. "America/New_York"
 * eventDate: ISO date string for the round e.g. "2026-04-10"
 */
export async function fetchLatestTeeTime(
  pdgaEventId: string,
  roundNumber: number,
  eventTimezone: string,
  eventDate: string
): Promise<Date | null> {
  const url = `https://www.pdga.com/tour/event/${encodeURIComponent(pdgaEventId)}`;
  let html: string;
  try {
    html = await fetchWithRetry(url);
  } catch {
    return null;
  }

  const $ = cheerio.load(html);
  const $mpoHeading = $('h3.division#MPO');
  if ($mpoHeading.length === 0) return null;

  const $details = $mpoHeading.closest('details');
  const teeTimes: Date[] = [];

  $details.find('tbody tr').each((_, row) => {
    $( row).find('td.round a.score').each((_, link) => {
      const href = $(link).attr('href') ?? '';
      const roundMatch = href.match(/[?&]round=(\d+)/);
      if (!roundMatch || parseInt(roundMatch[1], 10) !== roundNumber) return;

      const text = $(link).text().trim();
      // Tee time if not a pure integer
      if (/^\d+$/.test(text)) return;

      // Parse "3:00 pm" / "9:13 am"
      const timeMatch = text.match(/^(\d+):(\d+)\s*(am|pm)$/i);
      if (!timeMatch) return;

      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const meridiem = timeMatch[3].toLowerCase();
      if (meridiem === 'pm' && hours !== 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;

      // Build a UTC Date by interpreting the time in the event's local timezone.
      // Intl.DateTimeFormat gives us what UTC wall-clock looks like in the target tz,
      // so we find the offset by comparing a candidate UTC time to its tz representation.
      const pad = (n: number) => String(n).padStart(2, '0');
      const candidateStr = `${eventDate}T${pad(hours)}:${pad(minutes)}:00`;
      // Parse as if UTC first to get a reference point
      const candidateUtc = new Date(`${candidateStr}Z`);
      // Get what that UTC time looks like in the event timezone
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: eventTimezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(candidateUtc);
      const p: Record<string, string> = {};
      parts.forEach(({ type, value }) => { p[type] = value; });
      const tzHour = parseInt(p.hour === '24' ? '0' : p.hour, 10);
      const tzMin = parseInt(p.minute, 10);
      // Offset in ms between local tz time and UTC
      const offsetMs = (tzHour * 60 + tzMin - (hours * 60 + minutes)) * 60_000;
      const utcDate = new Date(candidateUtc.getTime() - offsetMs);

      teeTimes.push(utcDate);
    });
  });

  if (teeTimes.length === 0) return null;
  // Return the latest tee time
  return new Date(Math.max(...teeTimes.map((t) => t.getTime())));
}

// ---------------------------------------------------------------------------
// Course par scraping
// ---------------------------------------------------------------------------

/**
 * Scrapes course par for all rounds from the main PDGA event page.
 * Returns a map of sequential round_number (1..numRounds) → course_par.
 *
 * Par is read from layout-details tooltip divs that PDGA renders per round:
 *   <div id="layout-details-{eventId}-MPO-round-{n}">
 *     ...New London Tech Disc Golf Course - 2026 Champions Cup MPO; 18 holes; Par 69; 12,097 ft.
 *   </div>
 *
 * Finals format: PDGA uses round=12 for the final round (e.g. Champions Cup).
 * Rounds 1..numRounds-1 are sequential; the final round div uses round-12 (Finals)
 * or round-{numRounds} (standard). Returned map always uses sequential keys 1..numRounds.
 */
export async function scrapeAllRoundPars(
  pdgaEventId: string,
  numRounds: number
): Promise<Map<number, number>> {
  const url = `https://www.pdga.com/tour/event/${encodeURIComponent(pdgaEventId)}`;
  console.log(`scrapeAllRoundPars: fetching ${url} (numRounds=${numRounds})`);

  let html: string;
  try {
    html = await fetchWithRetry(url);
    console.log(`scrapeAllRoundPars: fetched ${html.length} bytes for event ${pdgaEventId}`);
  } catch (err) {
    console.warn(`scrapeAllRoundPars: failed to fetch event page for ${pdgaEventId}: ${err instanceof Error ? err.message : err}`);
    return new Map();
  }

  const $ = cheerio.load(html);

  // rawPars: keyed by PDGA round number from div id (may include 12 for Finals)
  const rawPars = new Map<number, number>();

  // Selector: all divs whose id starts with layout-details-{eventId}-MPO-round-
  const prefix = `layout-details-${pdgaEventId}-MPO-round-`;
  $(`div[id^="${prefix}"]`).each((_, el) => {
    const id = $(el).attr('id') ?? '';
    const roundStr = id.slice(prefix.length);
    const pdgaRound = parseInt(roundStr, 10);
    if (isNaN(pdgaRound)) return;

    const text = $(el).text();
    const parMatch = text.match(/\bPar\s+(\d+)/i);
    if (!parMatch) {
      console.warn(`scrapeAllRoundPars: div#${id} found but no "Par N" in text: "${text.trim().slice(0, 80)}"`);
      return;
    }

    const par = parseInt(parMatch[1], 10);
    console.log(`scrapeAllRoundPars: div#${id} → Par ${par}`);
    rawPars.set(pdgaRound, par);
  });

  if (rawPars.size === 0) {
    console.warn(`scrapeAllRoundPars: no layout-details divs found for event ${pdgaEventId} (prefix="${prefix}")`);
    return new Map();
  }

  console.log(`scrapeAllRoundPars: raw par values — ${JSON.stringify(Object.fromEntries(rawPars))}`);

  // Normalize PDGA round numbers to sequential 1..numRounds:
  //   Rounds 1..numRounds-1 map directly.
  //   Final round: prefer round=12 (Finals format), fall back to round=numRounds (standard).
  const result = new Map<number, number>();

  for (let rn = 1; rn < numRounds; rn++) {
    const par = rawPars.get(rn);
    if (par !== undefined) result.set(rn, par);
  }
  const finalPar = rawPars.get(12) ?? rawPars.get(numRounds);
  if (finalPar !== undefined) result.set(numRounds, finalPar);

  console.log(
    `scrapeAllRoundPars: result for event ${pdgaEventId} ` +
    `(raw PDGA keys: [${[...rawPars.keys()].join(',')}] → sequential): ` +
    JSON.stringify(Object.fromEntries(result))
  );

  return result;
}

// ---------------------------------------------------------------------------
// Public API — tries Layer 2 then falls back to Layer 3
// ---------------------------------------------------------------------------

export async function fetchEventScores(
  pdgaEventId: string,
  roundNumber: number
): Promise<ScrapedScore[]> {
  // Layer 2 (live scores page) returns par-relative totals, not absolute stroke counts.
  // Layer 3 (main event page) returns absolute stroke counts — the only reliable source.
  return scrapeHtmlScores(pdgaEventId, roundNumber);
}
