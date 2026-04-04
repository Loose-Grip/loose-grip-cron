import { supabase } from './supabase';

export type JobName = 'sync_events' | 'sync_players' | 'sync_scores' | 'check_timers' | 'check_completion';
export type JobStatus = 'success' | 'error' | 'skipped';

export interface ScraperLogEntry {
  job: JobName;
  status: JobStatus;
  message: string | null;
  duration_ms: number;
}

export async function logRun(entry: ScraperLogEntry): Promise<void> {
  const { error } = await supabase.from('scraper_logs').insert({
    job: entry.job,
    status: entry.status,
    message: entry.message,
    duration_ms: entry.duration_ms,
    created_at: new Date().toISOString(),
  });

  if (error) {
    // Don't throw — a logging failure must never crash the cron job itself.
    console.error('logRun: failed to write to scraper_logs:', error.message);
  }
}
