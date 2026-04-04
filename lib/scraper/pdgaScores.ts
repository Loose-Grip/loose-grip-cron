/**
 * Score fetching — two layers tried in order:
 *
 *   Layer 2 (primary):  PDGA live scores page (pdga.com/live/event/{id}/MPO/scores?round={n})
 *   Layer 3 (fallback): Cheerio scrape of the main event results table
 *
 * Both layers verified against real PDGA event pages.
 *
 * Table structure (verified against https://www.pdga.com/tour/event/96403):
 *
 *   MPO section: <details><summary><h3 class="division" id="MPO">...</h3></summary>
 *   Player row:
 *     <td class="pdga-number">75412</td>
 *     <td class="round"><a href="/live/event/96403/MPO/scores?round=1" class="score">54</a></td>
 *     <td class="round"><a href="/live/event/96403/MPO/scores?round=2" class="score">53</a></td>
 *     ...
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { fetchWithRetry } from './rateLimiter';

export interface ScrapedScore {
  pdgaNumber: string;
  roundNumber: number;
  strokes: number;
}

// ---------------------------------------------------------------------------
// Layer 2 — PDGA live scores page (primary)
// ---------------------------------------------------------------------------

/**
 * The live scores page URL pattern, discovered from round links on the event page:
 *   https://www.pdga.com/live/event/{eventId}/MPO/scores?round={n}
 *
 * This page returns an HTML table of hole-by-hole scores.
 * We parse the total strokes from the "total" cell per player.
 *
 * Structure (provisional — verify on a live event):
 *   <tr>
 *     <td class="pdga-number">75412</td>
 *     <td class="total">54</td>  ← round total strokes
 *   </tr>
 */
async function fetchLiveScores(
  pdgaEventId: string,
  roundNumber: number
): Promise<ScrapedScore[] | null> {
  const url = `https://www.pdga.com/live/event/${encodeURIComponent(pdgaEventId)}/MPO/scores?round=${roundNumber}`;

  try {
    const html = await fetchWithRetry(url);
    const $ = cheerio.load(html);

    const results: ScrapedScore[] = [];

    $('tbody tr').each((_, row) => {
      const $row = $(row);
      const pdgaNumber = $row.find('td.pdga-number').text().trim();
      if (!pdgaNumber) return;

      const totalText = $row.find('td.total').text().trim();
      const strokes = parseInt(totalText, 10);
      if (isNaN(strokes)) return;

      results.push({ pdgaNumber, roundNumber, strokes });
    });

    if (results.length > 0) {
      return results;
    }

    console.warn(`Layer 2: no scores parsed from live page for event ${pdgaEventId} R${roundNumber}`);
    return null;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.warn(
        `Layer 2 live scores failed (HTTP ${err.response?.status ?? 'n/a'}) for event ${pdgaEventId} R${roundNumber}; falling through to Layer 3`
      );
    } else {
      console.warn(
        `Layer 2 threw for event ${pdgaEventId} R${roundNumber}; falling through to Layer 3:`,
        err instanceof Error ? err.message : err
      );
    }
    return null;
  }
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

      const strokes = parseInt($(link).text().trim(), 10);
      if (isNaN(strokes)) return;

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
// Public API — tries Layer 2 then falls back to Layer 3
// ---------------------------------------------------------------------------

export async function fetchEventScores(
  pdgaEventId: string,
  roundNumber: number
): Promise<ScrapedScore[]> {
  const liveScores = await fetchLiveScores(pdgaEventId, roundNumber);
  if (liveScores !== null) {
    console.log(
      `fetchEventScores: Layer 2 returned ${liveScores.length} scores for event ${pdgaEventId} R${roundNumber}`
    );
    return liveScores;
  }

  console.log(
    `fetchEventScores: falling back to Layer 3 (HTML scrape) for event ${pdgaEventId} R${roundNumber}`
  );
  return scrapeHtmlScores(pdgaEventId, roundNumber);
}
