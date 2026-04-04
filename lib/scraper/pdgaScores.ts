/**
 * Score fetching — two layers tried in order:
 *
 *   Layer 2 (primary):  PDGA Live XHR endpoint
 *   Layer 3 (fallback): Cheerio HTML scrape of the event page
 *
 * ⚠️  Layer 2 endpoint URL is UNVERIFIED. It must be discovered by watching
 *     network requests on a live DGPT Elite Series event page:
 *       DevTools → Network → XHR → filter on pdga.com/apps/tournament
 *     Update TODO_VERIFY_URL below once confirmed.
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
// Layer 2 — PDGA Live XHR (primary)
// ---------------------------------------------------------------------------

// TODO: verify this endpoint URL by inspecting network requests during a live
// DGPT Elite Series event in browser DevTools (Network → XHR filter).
// Expected pattern (unverified):
//   https://api.pdga.com/apps/tournament/live/event/{eventId}/scores?division=MPO&round={n}
const TODO_VERIFY_BASE_URL = 'https://api.pdga.com/apps/tournament/live';

interface LiveScoreEntry {
  pdga_number?: string | number;
  round_score?: number | null;
  /** Some endpoints use different field names — handle both */
  score?: number | null;
  player_id?: string | number;
}

interface LiveScoresResponse {
  scores?: LiveScoreEntry[];
  data?: LiveScoreEntry[];
}

async function fetchLiveScores(
  pdgaEventId: string,
  roundNumber: number
): Promise<ScrapedScore[] | null> {
  // TODO: verify endpoint URL — this URL pattern is provisional
  const url = `${TODO_VERIFY_BASE_URL}/event/${encodeURIComponent(pdgaEventId)}/scores?division=MPO&round=${roundNumber}`;

  try {
    const response = await axios.get<LiveScoresResponse>(url, {
      timeout: 10_000,
      headers: {
        'User-Agent': 'loose-grip-pick-six/cron (polite scraper)',
        Accept: 'application/json',
      },
    });

    const entries: LiveScoreEntry[] = response.data?.scores ?? response.data?.data ?? [];
    if (entries.length === 0) return null;

    const results: ScrapedScore[] = [];
    for (const entry of entries) {
      const pdgaNumber = String(entry.pdga_number ?? entry.player_id ?? '').trim();
      const strokes = entry.round_score ?? entry.score ?? null;
      if (!pdgaNumber || strokes === null || strokes === undefined) continue;
      results.push({ pdgaNumber, roundNumber, strokes });
    }

    return results.length > 0 ? results : null;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.warn(
        `Layer 2 live scores failed (HTTP ${err.response?.status ?? 'n/a'}) for event ${pdgaEventId} round ${roundNumber}; falling through to Layer 3`
      );
    } else {
      console.warn(
        `Layer 2 live scores threw unexpectedly for event ${pdgaEventId} round ${roundNumber}; falling through to Layer 3:`,
        err instanceof Error ? err.message : err
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layer 3 — Cheerio HTML scrape (fallback)
// ---------------------------------------------------------------------------

/**
 * ⚠️  VERIFY SELECTORS: Inspect https://www.pdga.com/tour/event/<id> to confirm:
 *
 *   - Results table structure (MPO division)
 *   - Player link selector: a[href^="/player/"]  (provisional — verify)
 *   - Round score cell index: round n is in the nth td after the player name cell
 *   - Dash ("-") means round not yet played — skip those cells
 *
 * The table is typically structured as:
 *   <table class="views-table ...">
 *     <thead><tr><th>Place</th><th>Player</th><th>R1</th><th>R2</th>...</tr></thead>
 *     <tbody>
 *       <tr>
 *         <td>1</td>
 *         <td><a href="/player/12345">Paul McBeth</a></td>
 *         <td>56</td>   ← R1 strokes
 *         <td>54</td>   ← R2 strokes
 *         ...
 *       </tr>
 *     </tbody>
 *   </table>
 */
async function scrapeHtmlScores(
  pdgaEventId: string,
  roundNumber: number
): Promise<ScrapedScore[]> {
  const url = `https://www.pdga.com/tour/event/${encodeURIComponent(pdgaEventId)}`;
  const html = await fetchWithRetry(url);
  const $ = cheerio.load(html);

  const results: ScrapedScore[] = [];

  // ⚠️ TODO: Verify the exact table/section selector for the MPO division.
  // Provisional: find the MPO results table. PDGA pages often have multiple
  // division tables. Look for one preceded by an "MPO" heading or with a
  // data-division attribute.

  // Determine which column index contains round scores.
  // Scan thead to find columns labelled "R1", "R2", etc.
  let roundColIndex: number | null = null;

  // ⚠️ TODO: Verify table selector. Common patterns on PDGA event pages:
  //   .view-results table, table.views-table, #mpo-results table
  const $tables = $('table');

  $tables.each((_, table) => {
    const $table = $(table);

    // Heuristic: this is an MPO table if its nearest preceding heading says MPO
    // or if it has no division heading (single-division event).
    // ⚠️ TODO: Confirm this heuristic against a live multi-division event page.
    const precedingText = $table.prevAll('h2, h3, h4').first().text().trim().toUpperCase();
    if (precedingText && precedingText !== 'MPO') return; // skip non-MPO tables

    // Find the round column index from the header
    $table.find('thead tr th').each((colIdx, th) => {
      const headerText = $(th).text().trim().toUpperCase();
      // "R1", "RND 1", "ROUND 1", etc.
      if (new RegExp(`^R(?:ND\\s*|OUND\\s*)?${roundNumber}$`).test(headerText)) {
        roundColIndex = colIdx;
      }
    });

    if (roundColIndex === null) return; // this table doesn't have the target round

    $table.find('tbody tr').each((_, row) => {
      const $cells = $(row).find('td');

      // Find player link
      let pdgaNumber: string | null = null;
      $cells.each((_, cell) => {
        const $link = $(cell).find('a[href^="/player/"]').first();
        if ($link.length) {
          const href = $link.attr('href') ?? '';
          const match = href.match(/^\/player\/(\d+)/);
          if (match) pdgaNumber = match[1];
        }
      });

      if (!pdgaNumber) return;

      const $scoreCell = $cells.eq(roundColIndex!);
      const cellText = $scoreCell.text().trim();

      // Dash means round not yet played
      if (cellText === '-' || cellText === '' || cellText === 'DNF') return;

      const strokes = parseInt(cellText, 10);
      if (isNaN(strokes)) return;

      results.push({ pdgaNumber, roundNumber, strokes });
    });
  });

  if (results.length === 0) {
    console.warn(
      `Layer 3 HTML scrape: no scores found for event ${pdgaEventId} round ${roundNumber}. ` +
        'CSS selectors likely need updating — inspect the live page.'
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
