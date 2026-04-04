/**
 * DST-safe Melbourne time utilities.
 * Mirrors the identical implementation in the main Next.js app.
 *
 * Melbourne observes AEDT (UTC+11) in summer and AEST (UTC+10) in winter.
 * Using Intl.DateTimeFormat ensures correct DST handling without any manual
 * offset arithmetic.
 */

const MELBOURNE_TZ = 'Australia/Melbourne';
const ACTIVE_START_HOUR = 9;  // 09:00 Melbourne
const ACTIVE_END_HOUR = 21;   // 21:00 Melbourne (exclusive upper bound)

/** Returns the current hour (0–23) in Melbourne local time. */
export function getMelbourneHour(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: MELBOURNE_TZ,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);

  const hourPart = parts.find((p) => p.type === 'hour');
  if (!hourPart) throw new Error('Intl.DateTimeFormat did not return an hour part');

  // "24" is returned for midnight in some locales — normalise to 0
  const hour = parseInt(hourPart.value, 10);
  return hour === 24 ? 0 : hour;
}

/** Returns true if the given date falls within the active pick window (09:00–21:00 Melbourne). */
export function isInActiveWindow(date: Date): boolean {
  const hour = getMelbourneHour(date);
  return hour >= ACTIVE_START_HOUR && hour < ACTIVE_END_HOUR;
}

/**
 * Calculates the turn expiry given when the turn was opened, counting only
 * minutes within the active window (09:00–21:00 Melbourne).
 *
 * If the current minute falls outside the active window the timer is paused
 * until 09:00 the next morning (Melbourne time).
 *
 * Walks forward 1 minute at a time — correct for DST transitions because each
 * iteration re-evaluates the Melbourne hour rather than adding a fixed offset.
 *
 * @param turnOpenedAt       When the draft turn became available.
 * @param activeDurationMinutes  How many active-window minutes the player has.
 */
export function calculateTurnExpiry(
  turnOpenedAt: Date,
  activeDurationMinutes = 60
): Date {
  let cursor = new Date(turnOpenedAt.getTime());
  let activeMinutesRemaining = activeDurationMinutes;

  while (activeMinutesRemaining > 0) {
    if (isInActiveWindow(cursor)) {
      activeMinutesRemaining--;
      cursor = new Date(cursor.getTime() + 60_000); // advance 1 minute
    } else {
      // Outside active window — jump to 09:00 Melbourne the next day.
      // Get tomorrow's date string in Melbourne, then parse at 09:00.
      const tomorrow = new Date(cursor.getTime() + 24 * 60 * 60 * 1_000);
      const dateParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: MELBOURNE_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(tomorrow); // yields "YYYY-MM-DD"

      // Construct 09:00 Melbourne time by using the timezone-aware formatter
      // to find the UTC moment that equals 09:00 in Melbourne on that date.
      cursor = melbourneTimeToUTC(dateParts, ACTIVE_START_HOUR, 0);
    }
  }

  return cursor;
}

/**
 * Converts a Melbourne local date+time (YYYY-MM-DD, hour, minute) to a UTC
 * Date. Handles DST by binary-searching for the correct UTC offset.
 */
function melbourneTimeToUTC(yyyyMmDd: string, hour: number, minute: number): Date {
  // Estimate: Melbourne is UTC+10 or UTC+11. Start with UTC+10 as a baseline.
  const [year, month, day] = yyyyMmDd.split('-').map(Number);

  // Try UTC+10 first, then verify and adjust if DST applies.
  const baseOffsetMs = 10 * 60 * 60 * 1_000;
  const localMs =
    Date.UTC(year, month - 1, day, hour, minute) - baseOffsetMs;

  const candidate = new Date(localMs);

  // Verify: if getMelbourneHour returns the expected hour we're done.
  if (getMelbourneHour(candidate) === hour) return candidate;

  // DST active (UTC+11): subtract another hour.
  const dstCandidate = new Date(localMs - 60 * 60 * 1_000);
  if (getMelbourneHour(dstCandidate) === hour) return dstCandidate;

  // Fallback: return best candidate (off by at most 1 hour, shouldn't happen).
  return candidate;
}
