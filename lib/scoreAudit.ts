/**
 * scoreAudit.ts
 *
 * Post-round integrity checks for drafted player scores.
 * Called after each round is marked verified in syncScores.
 *
 * Checks performed:
 *   1. Missing scores      — active drafted player has no score row for the round
 *   2. Outlier scores      — strokes outside plausible PDGA pro range (45–85)
 *   3. Duplicate scores    — same player has >1 row for the same round
 *   4. Unoverwritten manual scores — round verified but manual-source rows remain
 *   5. Participant score drift — participant_scores total doesn't match sum of scores rows
 *
 * All issues fire admin alerts (fire-and-forget). No auto-correction.
 */

import axios from 'axios';
import { supabase } from './supabase';

// Plausible stroke range for an 18-hole PDGA pro round
const MIN_PLAUSIBLE_STROKES = 45;
const MAX_PLAUSIBLE_STROKES = 85;

interface AuditContext {
  appUrl: string;
  token: string;
  eventId: string;
  eventName: string;
  pdgaEventId: string;
  roundNumber: number;
}

function fireAlert(
  ctx: AuditContext,
  checkName: string,
  issues: string[]
): void {
  if (issues.length === 0) return;
  axios.post(
    `${ctx.appUrl.replace(/\/$/, '')}/api/cron/admin-alert`,
    {
      type: 'score_audit',
      event_name: ctx.eventName,
      round_number: ctx.roundNumber,
      check: checkName,
      issues,
    },
    { headers: { 'X-Service-Token': ctx.token }, timeout: 10_000 }
  ).catch((err: unknown) => {
    console.warn(`scoreAudit: admin-alert failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  });
}

export async function runScoreAudit(ctx: AuditContext): Promise<void> {
  const { eventId, pdgaEventId, roundNumber } = ctx;

  console.log(`scoreAudit: running checks for event ${pdgaEventId} R${roundNumber}`);

  // Fetch all active main picks (non-sub) for this event
  const { data: activePicks, error: picksError } = await supabase
    .from('draft_picks')
    .select('user_id, event_player_id, pick_slot')
    .eq('event_id', eventId)
    .eq('is_active', true)
    .eq('is_substitute', false)
    .not('picked_at', 'is', null);

  if (picksError || !activePicks) {
    console.warn(`scoreAudit: failed to fetch picks for event ${eventId}: ${picksError?.message}`);
    return;
  }

  // Fetch player names for readable alerts
  const playerIds = [...new Set(activePicks.map((p) => p.event_player_id).filter((id): id is string => !!id))];
  const { data: playerRows } = await supabase
    .from('event_players')
    .select('id, name')
    .in('id', playerIds);
  const playerName = Object.fromEntries((playerRows ?? []).map((p) => [p.id, p.name ?? p.id]));

  // Fetch user display names for readable alerts
  const userIds = [...new Set(activePicks.map((p) => p.user_id).filter((id): id is string => !!id))];
  const { data: userRows } = await supabase
    .from('users')
    .select('id, name')
    .in('id', userIds);
  const userName = Object.fromEntries((userRows ?? []).map((p) => [p.id, p.name ?? p.id]));

  // Fetch all score rows for this event + round
  const { data: scoreRows, error: scoresError } = await supabase
    .from('scores')
    .select('event_player_id, strokes, source')
    .eq('event_id', eventId)
    .eq('round_number', roundNumber);

  if (scoresError) {
    console.warn(`scoreAudit: failed to fetch scores for event ${eventId} R${roundNumber}: ${scoresError.message}`);
    return;
  }

  const scores = scoreRows ?? [];

  // Group by player for checks
  const scoresByPlayer = new Map<string, typeof scores>();
  for (const row of scores) {
    if (!row.event_player_id) continue;
    if (!scoresByPlayer.has(row.event_player_id)) scoresByPlayer.set(row.event_player_id, []);
    scoresByPlayer.get(row.event_player_id)!.push(row);
  }

  // ── Check 1: Missing scores ─────────────────────────────────────────────
  // Batch-fetch player statuses to avoid N+1 queries
  const { data: playerStatusRows } = await supabase
    .from('event_players')
    .select('id, status')
    .in('id', playerIds);
  const playerStatus = Object.fromEntries((playerStatusRows ?? []).map((p) => [p.id, p.status]));

  const missing: string[] = [];
  for (const pick of activePicks) {
    if (!pick.event_player_id) continue;
    if (playerStatus[pick.event_player_id] !== 'active') continue;
    const rows = scoresByPlayer.get(pick.event_player_id) ?? [];
    if (rows.length === 0) {
      missing.push(
        `${userName[pick.user_id ?? ''] ?? pick.user_id} → ${playerName[pick.event_player_id]} (slot ${pick.pick_slot}) has no score for R${roundNumber}`
      );
    }
  }
  if (missing.length > 0) {
    console.warn(`scoreAudit: CHECK 1 MISSING SCORES — ${missing.length} issue(s)`);
    fireAlert(ctx, 'missing_scores', missing);
  }

  // ── Check 2: Outlier scores ─────────────────────────────────────────────
  const outliers: string[] = [];
  for (const pick of activePicks) {
    if (!pick.event_player_id) continue;
    const rows = scoresByPlayer.get(pick.event_player_id) ?? [];
    for (const row of rows) {
      if (row.strokes === null || row.strokes >= 999) continue; // skip DNF sentinel
      if (row.strokes < MIN_PLAUSIBLE_STROKES || row.strokes > MAX_PLAUSIBLE_STROKES) {
        outliers.push(
          `${userName[pick.user_id ?? ''] ?? pick.user_id} → ${playerName[pick.event_player_id]}: strokes=${row.strokes} (expected ${MIN_PLAUSIBLE_STROKES}–${MAX_PLAUSIBLE_STROKES})`
        );
      }
    }
  }
  if (outliers.length > 0) {
    console.warn(`scoreAudit: CHECK 2 OUTLIER SCORES — ${outliers.length} issue(s)`);
    fireAlert(ctx, 'outlier_scores', outliers);
  }

  // ── Check 3: Duplicate scores ───────────────────────────────────────────
  const duplicates: string[] = [];
  for (const pick of activePicks) {
    if (!pick.event_player_id) continue;
    const rows = scoresByPlayer.get(pick.event_player_id) ?? [];
    if (rows.length > 1) {
      duplicates.push(
        `${playerName[pick.event_player_id]} has ${rows.length} score rows for R${roundNumber} (strokes: ${rows.map((r) => r.strokes).join(', ')})`
      );
    }
  }
  if (duplicates.length > 0) {
    console.warn(`scoreAudit: CHECK 3 DUPLICATE SCORES — ${duplicates.length} issue(s)`);
    fireAlert(ctx, 'duplicate_scores', duplicates);
  }

  // ── Check 4: Unoverwritten manual scores ────────────────────────────────
  const manualRemaining: string[] = [];
  for (const pick of activePicks) {
    if (!pick.event_player_id) continue;
    const rows = scoresByPlayer.get(pick.event_player_id) ?? [];
    for (const row of rows) {
      if (row.source === 'manual') {
        manualRemaining.push(
          `${userName[pick.user_id ?? ''] ?? pick.user_id} → ${playerName[pick.event_player_id]}: score source is still 'manual' (strokes=${row.strokes})`
        );
      }
    }
  }
  if (manualRemaining.length > 0) {
    console.warn(`scoreAudit: CHECK 4 MANUAL SCORES REMAINING — ${manualRemaining.length} issue(s)`);
    fireAlert(ctx, 'manual_scores_remaining', manualRemaining);
  }

  // ── Check 5: Participant score drift ────────────────────────────────────
  // For each user, sum their picks' raw strokes for this round and compare to
  // participant_scores.strokes_behind for this round.
  const { data: participantRoundRows } = await supabase
    .from('participant_scores')
    .select('user_id, strokes_behind')
    .eq('event_id', eventId)
    .eq('round_number', roundNumber);

  const participantScoreMap = new Map(
    (participantRoundRows ?? []).map((r) => [r.user_id, r.strokes_behind])
  );

  const drifts: string[] = [];
  const picksByUser = new Map<string, typeof activePicks>();
  for (const pick of activePicks) {
    if (!pick.user_id) continue;
    if (!picksByUser.has(pick.user_id)) picksByUser.set(pick.user_id, []);
    picksByUser.get(pick.user_id)!.push(pick);
  }

  for (const [userId, picks] of picksByUser) {
    let expectedTotal = 0;
    let hasAllScores = true;
    for (const pick of picks) {
      if (!pick.event_player_id) continue;
      const rows = scoresByPlayer.get(pick.event_player_id) ?? [];
      const validRow = rows.find((r) => r.strokes !== null && r.strokes < 999);
      if (!validRow) { hasAllScores = false; break; }
      expectedTotal += validRow.strokes!;
    }
    if (!hasAllScores) continue; // skip if picks have missing/DNF scores — drift expected

    const recorded = participantScoreMap.get(userId);
    if (recorded === undefined) {
      drifts.push(`${userName[userId] ?? userId}: no participant_scores row for R${roundNumber}`);
    } else if (recorded !== expectedTotal) {
      drifts.push(
        `${userName[userId] ?? userId}: participant_scores.strokes_behind=${recorded} but sum of pick scores=${expectedTotal} (drift=${recorded - expectedTotal})`
      );
    }
  }
  if (drifts.length > 0) {
    console.warn(`scoreAudit: CHECK 5 PARTICIPANT SCORE DRIFT — ${drifts.length} issue(s)`);
    fireAlert(ctx, 'participant_score_drift', drifts);
  }

  const totalIssues = missing.length + outliers.length + duplicates.length + manualRemaining.length + drifts.length;
  if (totalIssues === 0) {
    console.log(`scoreAudit: all checks passed for event ${pdgaEventId} R${roundNumber}`);
  } else {
    console.warn(`scoreAudit: ${totalIssues} total issue(s) found for event ${pdgaEventId} R${roundNumber} — admin alerts fired`);
  }
}
