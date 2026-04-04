/**
 * Scrapes MPO player list from a PDGA event page, then enriches each player
 * with rating and nationality via the PDGA JSON API.
 *
 * ⚠️  CSS SELECTORS MUST BE VERIFIED against a live PDGA event page before
 *     relying on them. The selectors below match the structure observed at
 *     https://www.pdga.com/tour/event/<id> as of 2025 — they may change.
 */

import * as cheerio from 'cheerio';
import axios from 'axios';
import { PdgaSession } from '../pdga/auth';
import { fetchWithRetry, delay, MIN_DELAY_MS } from './rateLimiter';

export interface ScrapedPlayer {
  pdgaNumber: string;
  name: string;
  pdgaRating: number | null;
  nationality: string | null;
}

interface PdgaPlayerApiResponse {
  current_rating?: number;
  country_code?: string;
}

interface PdgaApiListResponse {
  players?: PdgaPlayerApiResponse[];
}

/** In-process cache keyed by PDGA number to avoid duplicate API calls within a run */
const playerCache = new Map<string, { pdgaRating: number | null; nationality: string | null }>();

async function enrichPlayer(
  pdgaNumber: string,
  session: PdgaSession
): Promise<{ pdgaRating: number | null; nationality: string | null }> {
  if (playerCache.has(pdgaNumber)) {
    return playerCache.get(pdgaNumber)!;
  }

  await delay(MIN_DELAY_MS);

  try {
    const response = await axios.get<PdgaApiListResponse>(
      `https://api.pdga.com/services/json/players?pdga_number=${encodeURIComponent(pdgaNumber)}`,
      {
        headers: {
          Cookie: `${session.session_name}=${session.sessid}`,
        },
        timeout: 10_000,
      }
    );

    const player = response.data?.players?.[0];
    const result = {
      pdgaRating: player?.current_rating ?? null,
      nationality: player?.country_code ?? null,
    };

    playerCache.set(pdgaNumber, result);
    return result;
  } catch (err) {
    console.warn(
      `enrichPlayer: failed to fetch data for PDGA #${pdgaNumber}:`,
      err instanceof Error ? err.message : err
    );
    const fallback = { pdgaRating: null, nationality: null };
    playerCache.set(pdgaNumber, fallback);
    return fallback;
  }
}

/**
 * Scrapes MPO players from the PDGA event page.
 *
 * ⚠️  VERIFY SELECTORS: Inspect https://www.pdga.com/tour/event/<id> in
 *     browser DevTools before trusting these selectors:
 *
 *   - Division filter: look for a section/tab labelled "MPO". The provisional
 *     approach finds links matching a[href^="/player/"] within an MPO section.
 *     If the page uses JS-rendered tabs this scraper will need adjustment.
 *   - Player link href pattern: /player/<pdgaNumber>  (verified pattern)
 *   - Player name: link text content
 */
export async function scrapeEventPlayers(
  pdgaEventId: string,
  session: PdgaSession
): Promise<ScrapedPlayer[]> {
  const url = `https://www.pdga.com/tour/event/${encodeURIComponent(pdgaEventId)}`;
  const html = await fetchWithRetry(url);
  const $ = cheerio.load(html);

  // ⚠️ TODO: Verify selector — find the MPO division section.
  // The PDGA event page typically has a section per division. Common patterns:
  //   - A heading or tab with text "MPO"
  //   - A container with data-division="MPO" or class containing "mpo"
  // Provisional: find player links inside elements that contextually belong to MPO.
  // If the page has a single unified results table, filter by the division column instead.

  const rawPlayers: { pdgaNumber: string; name: string }[] = [];
  const seen = new Set<string>();

  // ⚠️ Provisional MPO section detection — MUST be verified against live page HTML.
  // Strategy: locate a heading or section element containing "MPO", then collect
  // all player links within that section until the next section heading.
  let mpoSectionFound = false;

  // Try data-attribute approach first (modern PDGA pages)
  $('[data-division="MPO"] a[href^="/player/"], .division-MPO a[href^="/player/"]').each(
    (_, el) => {
      mpoSectionFound = true;
      const href = $(el).attr('href') ?? '';
      const match = href.match(/^\/player\/(\d+)/);
      if (!match) return;
      const pdgaNumber = match[1];
      if (seen.has(pdgaNumber)) return;
      seen.add(pdgaNumber);
      rawPlayers.push({ pdgaNumber, name: $(el).text().trim() });
    }
  );

  // Fallback: heading-based detection
  if (!mpoSectionFound) {
    $('h2, h3, h4').each((_, heading) => {
      if ($(heading).text().trim().toUpperCase() !== 'MPO') return;
      // Collect all player links until the next same-level heading
      let node = $(heading).next();
      while (node.length && !node.is('h2, h3, h4')) {
        node.find('a[href^="/player/"]').each((_, el) => {
          const href = $(el).attr('href') ?? '';
          const match = href.match(/^\/player\/(\d+)/);
          if (!match) return;
          const pdgaNumber = match[1];
          if (seen.has(pdgaNumber)) return;
          seen.add(pdgaNumber);
          rawPlayers.push({ pdgaNumber, name: $(el).text().trim() });
        });
        node = node.next();
      }
    });
  }

  if (rawPlayers.length === 0) {
    console.warn(
      `scrapeEventPlayers: no MPO players found for event ${pdgaEventId}. ` +
        'CSS selectors likely need updating — inspect the live page.'
    );
  }

  // Enrich each player with rating + nationality from the API
  const players: ScrapedPlayer[] = [];
  for (const { pdgaNumber, name } of rawPlayers) {
    const { pdgaRating, nationality } = await enrichPlayer(pdgaNumber, session);
    players.push({ pdgaNumber, name, pdgaRating, nationality });
  }

  return players;
}
