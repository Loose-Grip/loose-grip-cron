import axios from 'axios';

export const MIN_DELAY_MS = 2000;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  maxRetries = 3
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await delay(MIN_DELAY_MS);
      const response = await axios.get<string>(url, {
        headers: {
          'User-Agent': 'loose-grip-pick-six/cron (polite scraper; contact: admin@loosegrip.app)',
        },
        timeout: 15_000,
      });
      return response.data;
    } catch (err) {
      const isLast = attempt === maxRetries;
      if (isLast) throw err;

      const backoffMs = attempt * 2_000; // 2s, 4s, 6s
      console.warn(
        `fetchWithRetry: attempt ${attempt} failed for ${url}; retrying in ${backoffMs}ms…`,
        err instanceof Error ? err.message : err
      );
      await delay(backoffMs);
    }
  }

  // TypeScript narrowing — unreachable but required for exhaustive return
  throw new Error(`fetchWithRetry exhausted all retries for ${url}`);
}
