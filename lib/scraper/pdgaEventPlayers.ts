/**
 * Scrapes MPO player list from a PDGA event page.
 *
 * Page structure (verified against https://www.pdga.com/tour/event/97336):
 *
 *   <div class="leaderboard singles mode-reg">
 *     <details>
 *       <summary><h3 class="division" id="MPO">MPO · Mixed Pro Open ...</h3></summary>
 *       <div class="tooltip-templates">...</div>
 *       <table>
 *         <tbody>
 *           <tr>
 *             <td class="player"><a href="/player/35876">Colten Montgomery</a></td>
 *             <td class="pdga-number">35876</td>
 *             <td class="player-rating propagator">1007</td>
 *             <td class="country">United States</td>
 *             ...
 *           </tr>
 *         </tbody>
 *       </table>
 *     </details>
 *   </div>
 *
 * Rating and PDGA number are available directly in the table — no API enrichment needed.
 */

import * as cheerio from 'cheerio';
import { fetchWithRetry } from './rateLimiter';

export interface ScrapedPlayer {
  pdgaNumber: string;
  name: string;
  pdgaRating: number | null;
  nationality: string | null;
}

export async function scrapeEventPlayers(pdgaEventId: string): Promise<ScrapedPlayer[]> {
  const url = `https://www.pdga.com/tour/event/${encodeURIComponent(pdgaEventId)}`;
  const html = await fetchWithRetry(url);
  const $ = cheerio.load(html);

  const players: ScrapedPlayer[] = [];
  const seen = new Set<string>();

  // Find the MPO division block — <h3 id="MPO"> inside a <details> block
  const $mpoHeading = $('h3.division#MPO');
  if ($mpoHeading.length === 0) {
    console.warn(`scrapeEventPlayers: no MPO division found for event ${pdgaEventId}`);
    return [];
  }

  // The player table is a sibling inside the same <details> element
  const $details = $mpoHeading.closest('details');
  const $table = $details.find('table');

  $table.find('tbody tr').each((_, row) => {
    const $row = $(row);

    // PDGA number from dedicated cell
    const pdgaNumberText = $row.find('td.pdga-number').text().trim();
    if (!pdgaNumberText) return;
    if (seen.has(pdgaNumberText)) return;
    seen.add(pdgaNumberText);

    // Player name from the link
    const name = $row.find('td.player a').text().trim();
    if (!name) return;

    // Rating — class is "player-rating" (may also have "propagator")
    const ratingText = $row.find('td.player-rating').text().trim();
    const pdgaRating = ratingText && ratingText !== '-' ? parseInt(ratingText, 10) : null;

    // Country
    const nationality = $row.find('td.country').text().trim() || null;

    players.push({
      pdgaNumber: pdgaNumberText,
      name,
      pdgaRating: pdgaRating !== null && !isNaN(pdgaRating) ? pdgaRating : null,
      nationality,
    });
  });

  if (players.length === 0) {
    console.warn(`scrapeEventPlayers: no players found in MPO table for event ${pdgaEventId}`);
  } else {
    console.log(`scrapeEventPlayers: found ${players.length} MPO players for event ${pdgaEventId}`);
  }

  return players;
}
