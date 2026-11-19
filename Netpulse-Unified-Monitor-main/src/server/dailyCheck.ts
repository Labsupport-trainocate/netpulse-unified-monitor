/**
 * Daily check: ONE automatic round (ping + speed test for every region) and ONE summary e-mail per day.
 *
 * Triggered by Vercel Cron -> GET /api/monitor/daily (see vercel.json). Manual tests in the browser are unchanged.
 *
 * E-mail rules (Resend):
 *   - Every day exactly one normal summary e-mail: "Everything is good", or "Completed with notes".
 *   - The only RED alert is the existing critical e-mail: ALERT_CONSECUTIVE_TIMEOUTS (default 5) or more ping
 *     requests in a row timed out in one region (sent by alerts.ts, separately, as soon as it happens).
 *   - Anything else (some packet loss, an unusual value, a region that could not be tested) is only written
 *     in the normal summary e-mail.
 *
 * The speed test runs on the server (Vercel) against each regional LibreSpeed server, so the numbers show the
 * path from the app's server to that region.
 */
import crypto from 'crypto';
import { UNIFIED_ENDPOINTS, type UnifiedEndpoint } from '../config/endpoints.js';
import { REGIONS, getAnomalies, getSamples, type Sample, type StoredAnomaly } from './metricsStore.js';
import { recordSamples } from './monitoring.js';
import { alertRecipients, sendEmailViaResend, redisConfig, redisPipeline, CRITICAL_MARK_KEY } from './alerts.js';

type ProbeResult = { region: string; status: string; detail?: string };
export interface DailyDeps {
  /** one ping round for all regions (runScheduledProbes in app.ts) */
  runPings: () => Promise<ProbeResult[]>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// The e-mail is sent only AFTER every test has finished. Push agents report back after their next poll (default 30 s)
// plus the ping itself (~10 s), so we keep waiting until all results are in. DAILY_MAX_WAIT_SECONDS is only the safety
// limit (default 50 s, which fits the 60 s function limit in vercel.json); raise both together if your plan allows it.
const maxWaitMs = (): number => {
  const n = Number(process.env.DAILY_MAX_WAIT_SECONDS);
  return (Number.isFinite(n) && n >= 10 && n <= 280 ? n : 50) * 1000;
};
export const DAILY_LAST_KEY = 'daily:last';

const REGION_NAMES: Record<string, string> = {
  'IN-DC01': 'Bangalore TATA', 'IN-DC02': 'Bangalore ACT', 'LK-DC01': 'Sri Lanka', 'SG-DC01': 'Singapore',
};

/* ------------------------------ server-side speed test ------------------------------ */

const speedSeconds = (): number => {
  const n = Number(process.env.DAILY_SPEED_SECONDS);
  return Number.isFinite(n) && n >= 2 && n <= 10 ? n : 5;
};
const withRand = (url: string, extra = '') => `${url}${url.includes('?') ? '&' : '?'}${extra}r=${Math.random()}`;

async function measurePing(url: string): Promise<{ pingMs: number; jitterMs: number }> {
  const times: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    const r = await fetch(withRand(url), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer();
    if (!r.ok) throw new Error(`ping HTTP ${r.status}`);
    if (i > 0) times.push(performance.now() - t0); // the first request also builds the TLS connection: not counted
  }
  let jit = 0;
  for (let i = 1; i < times.length; i++) jit += Math.abs(times[i] - times[i - 1]);
  return { pingMs: Math.min(...times), jitterMs: times.length > 1 ? jit / (times.length - 1) : 0 };
}

async function measureDownload(url: string, seconds: number): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), seconds * 1000);
  const t0 = performance.now();
  let bytes = 0;
  const stream = async () => {
    while (!ctrl.signal.aborted) {
      const r = await fetch(withRand(url, 'ckSize=50&'), { cache: 'no-store', signal: ctrl.signal });
      if (!r.ok || !r.body) throw new Error(`download HTTP ${r.status}`);
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    }
  };
  try {
    await Promise.allSettled([stream(), stream(), stream()]);
  } finally {
    clearTimeout(timer);
  }
  const secs = (performance.now() - t0) / 1000;
  return bytes > 0 ? (bytes * 8) / secs / 1e6 : 0;
}

async function measureUpload(url: string, seconds: number): Promise<number> {
  const blob = crypto.randomBytes(1024 * 1024); // 1 MB per request keeps slow links inside the time limit
  const deadline = Date.now() + seconds * 1000;
  const hardStop = AbortSignal.timeout(seconds * 1000 + 4000);
  const t0 = performance.now();
  let bytes = 0;
  const stream = async () => {
