/**
 * lib/draft/pickTimer.ts
 *
 * Pick timer logic for the Loose Grip snake draft.
 *
 * Rules (BR-05):
 * - Each participant has 1 active hour (60 minutes) to make their pick once notified.
 * - Active hours = 09:00–21:00 AEDT (Melbourne time) only.
 * - If the window reaches 21:00 before 60 active minutes have elapsed, the clock
 *   pauses and resumes at 09:00 the following day.
 * - Picks can be submitted at any time — the pause only affects auto-assignment.
 *
 * All times are calculated in Melbourne local time.
 * Melbourne = Australia/Melbourne (UTC+11 AEDT in summer, UTC+10 AEST in winter).
 * DST is handled via Intl.DateTimeFormat — no manual offset math.
 */

const MELBOURNE_TZ = 'Australia/Melbourne'
const PICK_WINDOW_START_HOUR = 9   // 09:00 local
const PICK_WINDOW_END_HOUR = 21    // 21:00 local
const ACTIVE_MINUTES_ALLOWED = 60

// Cache formatters at module level — Intl instantiation is expensive
// Use hourCycle: 'h23' explicitly (0–23) instead of hour12: false.
// hour12: false is locale-dependent and in newer ICU versions (Node 22+) en-AU
// can return "24" for midnight instead of "0", causing infinite loops.
const hourFormatter = new Intl.DateTimeFormat('en-AU', {
  timeZone: MELBOURNE_TZ,
  hour: 'numeric',
  hourCycle: 'h23',
})

const partsFormatter = new Intl.DateTimeFormat('en-AU', {
  timeZone: MELBOURNE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** Returns the Melbourne local hour (0–23) for a given Date. */
export function getMelbourneHour(date: Date): number {
  const parts = hourFormatter.formatToParts(date)
  const hourPart = parts.find((p) => p.type === 'hour')
  return parseInt(hourPart?.value ?? '0', 10)
}

/** Returns whether the given Date is within the active pick window (09:00–21:00 Melbourne). */
export function isInActiveWindow(date: Date): boolean {
  const hour = getMelbourneHour(date)
  return hour >= PICK_WINDOW_START_HOUR && hour < PICK_WINDOW_END_HOUR
}

/**
 * Calculates the wall-clock datetime when a participant's pick window will expire,
 * accounting for the overnight pause.
 *
 * @param turnOpenedAt — when the turn was opened (wall clock UTC)
 * @returns ISO string: the datetime when auto-pick should fire if no pick is made
 */
export function calculateTurnExpiry(turnOpenedAt: Date): Date {
  let remaining = ACTIVE_MINUTES_ALLOWED  // minutes left to count down
  let cursor = new Date(turnOpenedAt)

  // If turn opens outside the active window, advance to next 09:00 Melbourne
  if (!isInActiveWindow(cursor)) {
    cursor = nextWindowStart(cursor)
  }

  // Walk forward 1 minute at a time until we've consumed all active minutes.
  // This handles the overnight pause cleanly without complex arithmetic.
  // Max iterations: ~60 + overnight skip → well within safe range.
  let safetyLimit = 0
  while (remaining > 0) {
    if (++safetyLimit > 500) {
      console.error('calculateTurnExpiry: safety limit hit, cursor=', cursor.toISOString(), 'remaining=', remaining)
      break
    }
    const nextMinute = new Date(cursor.getTime() + 60_000)
    if (isInActiveWindow(cursor)) {
      remaining--
      cursor = nextMinute
    } else {
      // Jump to next window start instead of crawling through off-hours
      const next = nextWindowStart(cursor)
      // Safety: if nextWindowStart didn't advance, force-advance by 1 hour to avoid infinite loop
      cursor = next > cursor ? next : new Date(cursor.getTime() + 60 * 60_000)
    }
  }

  return cursor
}

/**
 * Returns the next 09:00 Melbourne time strictly after the given date.
 * If `date` is before 09:00 on its day, returns 09:00 same day.
 * Otherwise returns 09:00 next day.
 */
function nextWindowStart(date: Date): Date {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(date).map((p) => [p.type, p.value])
  )

  const year = parseInt(parts.year)
  const month = parseInt(parts.month) - 1  // JS months are 0-indexed
  const day = parseInt(parts.day)
  const hour = parseInt(parts.hour)

  // If before 09:00 today, target is 09:00 today; otherwise 09:00 tomorrow
  const targetDay = hour < PICK_WINDOW_START_HOUR ? day : day + 1

  // Construct 09:00 Melbourne in that day using a string parse trick:
  // Build a local ISO string and let the timezone lib resolve it.
  const localStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}T09:00:00`
  return melbourneLocalToUtc(localStr)
}

/**
 * Converts a Melbourne local datetime string (YYYY-MM-DDTHH:MM:SS, no timezone)
 * to a UTC Date. Uses binary search to find the UTC offset for DST safety.
 */
function melbourneLocalToUtc(localStr: string): Date {
  // Strategy: try a candidate UTC time and check what Melbourne local time it produces.
  // Binary search within ±14h to find the UTC time that matches the local string.
  const targetMs = new Date(localStr + 'Z').getTime()  // treat as UTC initially
  const offsetGuessMs = -11 * 60 * 60 * 1000  // Melbourne is UTC+10 or UTC+11

  let low = targetMs + offsetGuessMs - 60 * 60 * 1000  // 1h buffer
  let high = targetMs + offsetGuessMs + 60 * 60 * 1000

  for (let i = 0; i < 30; i++) {
    const mid = Math.floor((low + high) / 2)
    const candidate = new Date(mid)
    const candidateLocal = toMelbourneLocalString(candidate)
    if (candidateLocal < localStr) {
      low = mid
    } else {
      high = mid
    }
  }

  return new Date(Math.floor((low + high) / 2))
}

/** Returns a Melbourne local datetime string (YYYY-MM-DDTHH:MM:SS) for a UTC Date. */
function toMelbourneLocalString(date: Date): string {
  const p = Object.fromEntries(partsFormatter.formatToParts(date).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}

/**
 * Calculates how many active minutes have elapsed since `turnOpenedAt`.
 * Used by the cron job to determine if a turn has expired.
 */
export function getActiveMinutesElapsed(turnOpenedAt: Date, now: Date): number {
  let elapsed = 0
  let cursor = new Date(turnOpenedAt)

  // If turn opened outside window, advance to window start (no time counted yet)
  if (!isInActiveWindow(cursor)) {
    cursor = nextWindowStart(cursor)
  }

  // Don't count future time
  const end = now < cursor ? cursor : now

  let safetyLimit = 0
  while (cursor < end) {
    if (++safetyLimit > 5000) {
      console.error('getActiveMinutesElapsed: safety limit hit, cursor=', cursor.toISOString())
      break
    }
    const nextMinute = new Date(cursor.getTime() + 60_000)
    const nextCursor = nextMinute < end ? nextMinute : end
    if (isInActiveWindow(cursor)) {
      elapsed += (nextCursor.getTime() - cursor.getTime()) / 60_000
    }
    cursor = nextCursor
    if (!isInActiveWindow(cursor) && cursor < end) {
      const skip = nextWindowStart(cursor)
      cursor = skip < end ? skip : end
    }
  }

  return elapsed
}

/** Returns true if a turn has expired (≥60 active minutes elapsed). */
export function isTurnExpired(turnOpenedAt: Date, now: Date = new Date()): boolean {
  return getActiveMinutesElapsed(turnOpenedAt, now) >= ACTIVE_MINUTES_ALLOWED
}
