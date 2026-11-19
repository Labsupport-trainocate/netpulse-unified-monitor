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
import { SPEED_LAST_KEY } from './speedAgent.js';

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
const SPEED_MAX_AGE_MS = 8 * 3_600_000; // the office speed agent runs early in the morning; results up to 8 hours old count as today's

// By default the speed numbers come from the office speed agent (the company network). The old cloud test
// (run from Vercel's server) is kept only as an option: DAILY_CLOUD_SPEED=on.
const cloudSpeed = (): boolean => process.env.DAILY_CLOUD_SPEED?.trim().toLowerCase() === 'on';

async function lastSpeedFailure(region: string): Promise<string> {
  if (!redisConfig()) return '';
  try {
    const [raw] = await redisPipeline([['GET', SPEED_LAST_KEY(region)]]);
    const d = raw ? JSON.parse(raw) : null;
    if (d && d.ok === false && typeof d.t === 'number' && Date.now() - d.t < SPEED_MAX_AGE_MS) return String(d.error || 'no answer');
  } catch { /* ignore */ }
  return '';
}

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
    while (Date.now() < deadline) {
      const r = await fetch(withRand(url), { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' }, cache: 'no-store', signal: hardStop });
      await r.arrayBuffer();
      if (!r.ok) throw new Error(`upload HTTP ${r.status}`);
      bytes += blob.length;
    }
  };
  await Promise.allSettled([stream(), stream()]);
  const secs = (performance.now() - t0) / 1000;
  return bytes > 0 ? (bytes * 8) / secs / 1e6 : 0;
}

async function speedForRegion(ep: UnifiedEndpoint): Promise<Sample> {
  const secs = speedSeconds();
  const p = await measurePing(ep.pingUrl);
  const down = await measureDownload(ep.downloadUrl, secs);
  const up = await measureUpload(ep.uploadUrl, secs);
  const m: Record<string, number> = { pingMs: p.pingMs, jitterMs: p.jitterMs };
  if (down > 0) m.downloadMbps = down;
  if (up > 0) m.uploadMbps = up;
  const t = Date.now();
  return { id: `speed:${ep.serverCode}:sched_${t}`, t, kind: 'speed', region: ep.serverCode, source: 'scheduled', m };
}

async function runSpeedRound(): Promise<{ samples: Map<string, Sample>; errors: Map<string, string> }> {
  const samples = new Map<string, Sample>();
  const errors = new Map<string, string>();
  await Promise.all(
    UNIFIED_ENDPOINTS.map(async (ep) => {
      try { samples.set(ep.serverCode, await speedForRegion(ep)); }
      catch (e: any) { errors.set(ep.serverCode, e?.name === 'TimeoutError' ? 'the speed server did not answer in time' : e?.message || 'speed test failed'); }
    })
  );
  if (samples.size) await recordSamples([...samples.values()]).catch((e) => console.error('[daily] could not store speed results:', e?.message || e));
  return { samples, errors };
}

/* ------------------------------ waiting for push agents ------------------------------ */

async function waitForScheduledPing(regions: string[], since: number, until: number): Promise<void> {
  while (regions.length && Date.now() < until) {
    const have = await Promise.all(
      regions.map((r) => getSamples('ping', r, since - 60_000, Date.now() + 1000, 10).then((x) => x.length > 0).catch(() => false))
    );
    if (have.every(Boolean)) return;
    await sleep(2000);
  }
}

/* ------------------------------ building the report ------------------------------ */

type Overall = 'good' | 'notes' | 'critical';
type Verdict = 'ok' | 'unusual' | 'critical' | 'none';
interface Tile { label: string; value: string; unit: string; verdict: Verdict; hint: string }
interface Attention { region: string; level: 'critical' | 'unusual' | 'missing'; title: string; text: string; check: string }
interface Row {
  region: string; status: 'ok' | 'note' | 'critical';
  ping: string; speed: string;                 // short text versions (plain-text mail and the API answer)
  pingTiles: Tile[]; speedTiles: Tile[];       // the boxes shown in the e-mail
  attention: Attention[];
}

const f1 = (v: unknown) => (typeof v === 'number' ? v.toFixed(1) : 'n/a');
const num1 = (v: number) => String(Math.round(v * 10) / 10);   // 7 -> "7", 2.74 -> "2.7"

/** The six boxes of a region card, and which anomaly metric belongs to which box. */
const TILE_OF: Record<string, string> = {
  'ping:avgLatencyMs': 'ping.avg', 'ping:jitterMs': 'ping.jitter', 'ping:packetLossPercent': 'ping.loss',
  'speed:downloadMbps': 'speed.down', 'speed:uploadMbps': 'speed.up', 'speed:pingMs': 'speed.ping',
};
const TILE_NAME: Record<string, string> = {
  'ping.avg': 'Ping delay', 'ping.jitter': 'Jitter', 'ping.loss': 'Packet loss',
  'speed.down': 'Download', 'speed.up': 'Upload', 'speed.ping': 'Delay',
};
const TITLE_NAME: Record<string, string> = {
  'ping.avg': 'Ping delay', 'ping.jitter': 'Ping jitter', 'ping.loss': 'Packet loss',
  'speed.down': 'Download speed', 'speed.up': 'Upload speed', 'speed.ping': 'Speed-test delay',
};
/** Plain-language "what to check" for each kind of finding. */
const CHECK: Record<string, string> = {
  'ping.avg': 'The path from this data centre to the internet is slower than usual. Check the internet link and any recent network changes, then run the ping test again.',
  'ping.jitter': 'The delay is jumping up and down, which makes calls and web pages feel choppy. Check for a busy or unstable link.',
  'ping.loss': 'Some test requests got no reply. Check the link or the internet provider, then run the test again.',
  'speed.down': 'Download speed to this data centre is lower than usual. Check for heavy traffic or a speed limit on the link.',
  'speed.up': 'Upload speed to this data centre is lower than usual. Check for heavy traffic or a speed limit on the link.',
  'speed.ping': 'The round-trip delay from the office to this data centre is higher than usual. Check the office internet link and the route.',
  'speed.jitter': 'The delay of the office speed test is jumping around. Check for a busy or unstable link.',
};

/** "usually about 7 ms (about 3.4 times higher)" in plain words. */
function usual(a: StoredAnomaly, unit: string): string {
  const base = a.baselineMedian;
  if (base === null || base === undefined) return '';
  if (base < 1 && (unit === 'ms' || unit === '%')) return 'It is normally close to 0.';
  const high = a.value > base;
  const ratio = base > 0 ? (high ? a.value / base : base / a.value) : 0;
  const how = ratio >= 1.5 ? `about ${num1(ratio)} times ${high ? 'higher' : 'lower'}`
    : `about ${Math.round(Math.abs(a.value - base) / base * 100)}% ${high ? 'higher' : 'lower'}`;
  return `It is usually about ${num1(base)} ${unit} (${how}).`;
}

function tile(key: string, value: number | undefined, unit: string, anomaly?: StoredAnomaly, extra?: { lossSome?: boolean }): Tile {
  const label = TILE_NAME[key];
  if (value === undefined) return { label, value: '-', unit: '', verdict: 'none', hint: 'no result' };
  const v = f1(value);
  if (anomaly) {
    const high = anomaly.baselineMedian !== null ? anomaly.value > anomaly.baselineMedian : key !== 'speed.down' && key !== 'speed.up';
    const base = anomaly.baselineMedian;
    const hint = base !== null && base >= 1 ? `${high ? '▲ higher' : '▼ lower'} · usually ~${num1(base)} ${unit}`
      : `${high ? '▲ higher' : '▼ lower'} than usual`;
    return { label, value: v, unit, verdict: anomaly.severity === 'critical' ? 'critical' : 'unusual', hint };
  }
  if (extra?.lossSome) return { label, value: v, unit, verdict: 'unusual', hint: '▲ some requests timed out' };
  return { label, value: v, unit, verdict: 'ok', hint: '✔ normal' };
}

async function buildReport(since: number, pingRes: ProbeResult[], speed: Awaited<ReturnType<typeof runSpeedRound>>) {
  const from = since - 60_000;
  const anomalies: StoredAnomaly[] = await getAnomalies(from, Date.now() + 1000, 200).catch(() => []);
  const marks: Array<string | null> = redisConfig()
    ? await redisPipeline(REGIONS.map((r) => ['GET', CRITICAL_MARK_KEY(r)])).catch(() => REGIONS.map(() => null))
    : REGIONS.map(() => null);

  const rows: Row[] = [];
  for (let i = 0; i < REGIONS.length; i++) {
    const region = REGIONS[i];
    const attention: Attention[] = [];
    const missing = (title: string, text: string, check: string) => attention.push({ region, level: 'missing', title, text, check });

    // the newest unusual finding for every box
    const flagged = new Map<string, StoredAnomaly>();
    const extra: StoredAnomaly[] = [];
    for (const a of anomalies.filter((x) => x.region === region).sort((x, y) => x.t - y.t)) {
      const key = TILE_OF[`${a.kind}:${a.metric}`];
      if (key) flagged.set(key, a); else extra.push(a);
    }

    // ping (measured by the agent inside the data centre)
    const ps = (await getSamples('ping', region, from, Date.now() + 1000, 20).catch(() => [] as Sample[])).sort((a, b) => b.t - a.t)[0];
    let ping = 'no result';
    let pingTiles: Tile[];
    if (ps) {
      const loss = ps.m.packetLossPercent ?? 0;
      ping = `avg ${f1(ps.m.avgLatencyMs)} ms, loss ${f1(loss)} %`;
      pingTiles = [
        tile('ping.avg', ps.m.avgLatencyMs, 'ms', flagged.get('ping.avg')),
        tile('ping.loss', loss, '%', flagged.get('ping.loss'), { lossSome: loss > 0 }),
        tile('ping.jitter', ps.m.jitterMs, 'ms', flagged.get('ping.jitter')),
      ];
      if (loss > 0 && !flagged.has('ping.loss')) {
        attention.push({ region, level: 'unusual', title: 'Some ping requests got no reply',
          text: `${f1(loss)} % of the test requests timed out (fewer than 5 in a row, so it is not critical).`, check: CHECK['ping.loss'] });
      }
    } else {
      const pr = pingRes.find((x) => x.region === region);
      const why = pr?.status === 'agent_offline' ? 'The ping agent on this data centre\u2019s VM is offline.'
        : pr?.status === 'queued' ? `The ping agent did not answer within ${Math.round(maxWaitMs() / 1000)} seconds.`
        : pr?.status === 'skipped' ? (pr.detail || 'No ping source is set up for this region.')
        : pr?.detail || 'No result was received.';
      missing('Ping was not tested', why, 'Check that the ping-agent service is running on this region\u2019s VM (systemctl status ping-agent).');
      pingTiles = ['ping.avg', 'ping.loss', 'ping.jitter'].map((k) => tile(k, undefined, ''));
    }

    // speed (measured from the office network)
    let ss = speed.samples.get(region);
    let speedFailure = '';
    if (!ss && !cloudSpeed()) {
      const since8h = Date.now() - SPEED_MAX_AGE_MS;
      ss = (await getSamples('speed', region, since8h, Date.now() + 1000, 20).catch(() => [] as Sample[]))
        .filter((s) => s.source === 'agent').sort((a, b) => b.t - a.t)[0];
      if (!ss) speedFailure = await lastSpeedFailure(region);
    }
    let spd = 'no result';
    let speedTiles: Tile[];
    if (ss) {
      spd = `down ${f1(ss.m.downloadMbps)} / up ${f1(ss.m.uploadMbps)} Mbps, ping ${f1(ss.m.pingMs)} ms`;
      speedTiles = [
        tile('speed.down', ss.m.downloadMbps, 'Mbps', flagged.get('speed.down')),
        tile('speed.up', ss.m.uploadMbps, 'Mbps', flagged.get('speed.up')),
        tile('speed.ping', ss.m.pingMs, 'ms', flagged.get('speed.ping')),
      ];
      if (ss.m.downloadMbps === undefined || ss.m.uploadMbps === undefined) {
        missing('Speed test is incomplete', 'Download or upload could not be measured.', 'Run the speed test again from the Speed Test page.');
      }
    } else {
      speedTiles = ['speed.down', 'speed.up', 'speed.ping'].map((k) => tile(k, undefined, ''));
      if (cloudSpeed()) missing('Speed test did not complete', speed.errors.get(region) || 'No result.', 'Run the speed test again from the Speed Test page.');
      else if (speedFailure) missing('Speed test could not reach this region', `From the office network: ${speedFailure}.`, 'Check that the speed server of this region is running and reachable from the office network.');
      else missing('No speed result from the office network', 'The office speed agent has not reported in the last 8 hours.', 'Check that the speed-agent timer is active on the office machine (systemctl list-timers speed-agent.timer).');
    }

    // plain-language explanation of every unusual finding
    for (const [key, a] of flagged) {
      const t = [...pingTiles, ...speedTiles].find((x) => x.label === TILE_NAME[key]);
      const unit = a.kind === 'ping' && key === 'ping.loss' ? '%' : (t?.unit || '');
      attention.push({ region, level: a.severity === 'critical' ? 'critical' : 'unusual',
        title: `${TITLE_NAME[key]} is ${a.baselineMedian !== null && a.value < a.baselineMedian ? 'lower' : 'higher'} than usual`,
        text: `${TITLE_NAME[key]} is ${f1(a.value)} ${unit}. ${usual(a, unit)}`.trim(), check: CHECK[key] });
    }
    for (const a of extra) {
      const key = `${a.kind}.${a.metric.replace(/Mbps|Ms|Percent/g, '').replace(/^./, (c) => c.toLowerCase())}`;
      attention.push({ region, level: 'unusual', title: `${a.kind === 'ping' ? 'Ping' : 'Speed-test'} ${a.label.toLowerCase()} is unusual`,
        text: `${a.kind === 'ping' ? 'Ping' : 'Speed-test'} ${a.label.toLowerCase()} is ${f1(a.value)}. ${usual(a, a.metric.toLowerCase().includes('mbps') ? 'Mbps' : a.metric.toLowerCase().includes('percent') ? '%' : 'ms')}`.trim(),
        check: CHECK[key] || 'Run the test again and compare with the dashboard.' });
    }

    let status: Row['status'] = attention.length ? 'note' : 'ok';
    let mark: any = null;
    try { mark = marks[i] ? JSON.parse(marks[i] as string) : null; } catch { /* ignore */ }
    if (mark && typeof mark.t === 'number' && mark.t >= from) {
      status = 'critical';
      attention.unshift({ region, level: 'critical', title: 'Critical: ping requests are timing out',
        text: `${mark.maxRun} ping requests in a row got no reply. The red critical alert e-mail was sent for this region.`,
        check: 'Check the data centre\u2019s internet link right away.' });
      if (pingTiles[1]) pingTiles[1] = { ...pingTiles[1], verdict: 'critical' };
    }
    rows.push({ region, ping, speed: spd, status, pingTiles, speedTiles, attention });
  }
  const overall: Overall = rows.some((r) => r.status === 'critical') ? 'critical' : rows.some((r) => r.status === 'note') ? 'notes' : 'good';
  return { rows, overall };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const istDate = (d: Date) => d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const istTime = (d: Date) => d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
const istDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD

/* Colours used in the e-mail: [background, border, strong text, emoji] */
const TONE: Record<string, [string, string, string, string]> = {
  ok: ['#ecfdf5', '#a7f3d0', '#047857', '🟢'],
  unusual: ['#fffbeb', '#fcd34d', '#b45309', '🟠'],
  critical: ['#fef2f2', '#fca5a5', '#b91c1c', '🔴'],
  none: ['#f3f4f6', '#d1d5db', '#6b7280', '⚪'],
};
const FONT = "font-family:'Segoe UI Emoji','Segoe UI',Arial,sans-serif;";
const rowTone = (s: Row['status']) => (s === 'ok' ? 'ok' : s === 'note' ? 'unusual' : 'critical');

function buildMail(report: { rows: Row[]; overall: Overall }, now: Date) {
  const day = istDate(now);
  const total = report.rows.length;
  const okCount = report.rows.filter((r) => r.status === 'ok').length;
  const needCount = total - okCount;
  const critRegions = report.rows.filter((r) => r.status === 'critical').map((r) => r.region);
  const title = report.overall === 'good' ? 'Everything is good'
    : report.overall === 'notes' ? 'Completed with notes'
    : 'Critical alert raised - please check';
  const subject = `Daily Network Check - ${day}: ${title}`;
  const dash = process.env.ALERT_DASHBOARD_URL?.trim() || '';
  const head = report.overall === 'good' ? { icon: '✅', color: '#047857', bg: '#ecfdf5', line: 'All regions look normal',
      sub: `All ${total} regions were tested and every result is in its usual range.` }
    : report.overall === 'notes' ? { icon: '⚠️', color: '#b45309', bg: '#fffbeb', line: `${needCount} of ${total} regions need a look`,
      sub: 'Nothing is critical. The boxes below show what is different from usual and what to check.' }
    : { icon: '🚨', color: '#b91c1c', bg: '#fef2f2', line: 'Critical: please act now',
      sub: `5 or more ping requests in a row got no reply in ${critRegions.join(', ')}. A separate red alert e-mail was also sent.` };
  const attention = report.rows.flatMap((r) => r.attention);
  const sourceNote = cloudSpeed() ? 'from the cloud server' : 'from the office network';

  /* ---------- plain-text version ---------- */
  const text = [
    `NETWORK MONITOR - DAILY CHECK (${day}, ${istTime(now)} IST)`, '', `${title.toUpperCase()}`, head.sub, '',
    ...report.rows.map((r) => `${r.status === 'ok' ? '[OK]      ' : r.status === 'note' ? '[LOOK]    ' : '[CRITICAL]'} ${r.region} (${REGION_NAMES[r.region] || ''})\n    Ping : ${r.ping}\n    Speed: ${r.speed}  (${sourceNote})`),
    ...(attention.length ? ['', 'WHAT NEEDS YOUR ATTENTION', ...attention.map((n) => `- ${n.region}: ${n.title}. ${n.text}\n    What to check: ${n.check}`)] : ['', 'Nothing needs your attention today.']),
    ...(dash ? ['', `Dashboard: ${dash}`] : []), '',
    'Automated message, sent once a day. A red critical alert is sent separately only when 5 or more ping requests in a row time out in a region.',
  ].join('\n');

  /* ---------- picture-style HTML version ---------- */
  const tileHtml = (t: Tile) => {
    const [bg, bd, fg] = TONE[t.verdict];
    return `<td width="33%" valign="top" style="padding:4px;">` +
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${bg};border:1px solid ${bd};border-radius:8px;">` +
      `<tr><td style="padding:9px 10px 10px;${FONT}">` +
      `<div style="font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;color:#6b7280;font-weight:700;">${esc(t.label)}</div>` +
      `<div style="margin-top:3px;font-size:25px;line-height:28px;font-weight:700;color:${fg};">${esc(t.value)}<span style="font-size:12px;font-weight:600;color:#6b7280;"> ${esc(t.unit)}</span></div>` +
      `<div style="margin-top:3px;font-size:11.5px;line-height:15px;color:${fg};">${esc(t.hint)}</div>` +
      `</td></tr></table></td>`;
  };
  const group = (icon: string, name: string, desc: string, tiles: Tile[]) =>
    `<tr><td style="padding:10px 12px 0;${FONT}font-size:12px;color:#374151;"><b>${icon} ${esc(name)}</b> <span style="color:#6b7280;">&middot; ${esc(desc)}</span></td></tr>` +
    `<tr><td style="padding:2px 8px 0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${tiles.map(tileHtml).join('')}</tr></table></td></tr>`;

  const overview = report.rows.map((r) => {
    const [bg, bd, fg, em] = TONE[rowTone(r.status)];
    const word = r.status === 'ok' ? 'Normal' : r.status === 'note' ? 'Take a look' : 'Critical';
    return `<td width="25%" valign="top" style="padding:4px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${bg};border:1px solid ${bd};border-radius:8px;"><tr><td align="center" style="padding:10px 4px;${FONT}">` +
      `<div style="font-size:22px;line-height:26px;">${em}</div><div style="font-size:13px;font-weight:700;color:#111827;margin-top:2px;">${esc(r.region)}</div>` +
      `<div style="font-size:11px;color:#6b7280;">${esc(REGION_NAMES[r.region] || '')}</div><div style="font-size:11.5px;font-weight:700;color:${fg};margin-top:3px;">${word}</div></td></tr></table></td>`;
  }).join('');

  const cards = report.rows.map((r) => {
    const [bg, bd, fg, em] = TONE[rowTone(r.status)];
    const word = r.status === 'ok' ? 'Normal' : r.status === 'note' ? 'Take a look' : 'Critical';
    return `<tr><td style="padding:6px 0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-left:5px solid ${fg};border-radius:8px;background:#ffffff;">` +
      `<tr><td style="padding:11px 12px 2px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>` +
      `<td style="${FONT}"><span style="font-size:15px;font-weight:700;color:#111827;">${em} ${esc(r.region)}</span> <span style="font-size:12px;color:#6b7280;">&middot; ${esc(REGION_NAMES[r.region] || '')}</span></td>` +
      `<td align="right" style="${FONT}white-space:nowrap;"><span style="font-size:11px;font-weight:700;color:${fg};background:${bg};border:1px solid ${bd};border-radius:10px;padding:2px 9px;">${word}</span></td>` +
      `</tr></table></td></tr>` +
      group('📡', 'PING', 'measured by the agent in the data centre', r.pingTiles) +
      group('🚀', 'SPEED', `measured ${sourceNote}`, r.speedTiles) +
      `<tr><td style="height:8px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`;
  }).join('');

  const attHtml = attention.length
    ? attention.map((n) => {
        const tone = n.level === 'critical' ? 'critical' : n.level === 'unusual' ? 'unusual' : 'none';
        const [bg, bd, fg] = TONE[tone];
        const em = n.level === 'critical' ? '🚨' : n.level === 'unusual' ? '⚠️' : 'ℹ️';
        return `<tr><td style="padding:4px 0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${bg};border:1px solid ${bd};border-radius:8px;"><tr>` +
          `<td width="40" valign="top" align="center" style="padding:11px 0 0 6px;font-size:20px;${FONT}">${em}</td>` +
          `<td style="padding:10px 12px 11px 4px;${FONT}"><div style="font-size:13.5px;font-weight:700;color:#111827;">${esc(n.region)} &middot; ${esc(n.title)}</div>` +
          `<div style="font-size:12.5px;line-height:18px;color:#374151;margin-top:3px;">${esc(n.text)}</div>` +
          `<div style="font-size:12.5px;line-height:18px;color:${fg};margin-top:5px;"><b>What to check:</b> ${esc(n.check)}</div></td></tr></table></td></tr>`;
      }).join('')
    : `<tr><td style="padding:4px 0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;"><tr><td width="40" align="center" style="padding:11px 0 11px 6px;font-size:20px;${FONT}">✅</td><td style="padding:12px 12px 12px 4px;${FONT}font-size:13.5px;color:#047857;font-weight:700;">Nothing needs your attention today.</td></tr></table></td></tr>`;

  const html =
    `<div style="background:#f3f4f6;padding:14px 8px;${FONT}">` +
    `<table role="presentation" align="center" width="100%" cellspacing="0" cellpadding="0" style="max-width:660px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">` +
    `<tr><td style="background:#0F4761;color:#ffffff;padding:18px 22px;${FONT}"><div style="font-size:11.5px;letter-spacing:1.2px;opacity:.85;">NETWORK MONITOR</div>` +
    `<div style="font-size:20px;font-weight:700;margin-top:4px;">Daily network check</div><div style="font-size:12.5px;opacity:.9;margin-top:3px;">${esc(day)} &middot; ${esc(istTime(now))} IST</div></td></tr>` +
    // big status banner
    `<tr><td style="padding:16px 16px 6px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${head.bg};border:1px solid ${TONE[report.overall === 'good' ? 'ok' : report.overall === 'notes' ? 'unusual' : 'critical'][1]};border-radius:10px;"><tr>` +
    `<td width="64" align="center" style="padding:14px 0 14px 10px;font-size:36px;line-height:40px;${FONT}">${head.icon}</td>` +
    `<td style="padding:14px 16px 14px 8px;${FONT}"><div style="font-size:19px;font-weight:700;color:${head.color};">${esc(head.line)}</div><div style="font-size:13px;line-height:18px;color:#374151;margin-top:4px;">${esc(head.sub)}</div></td></tr></table></td></tr>` +
    // four region tiles
    `<tr><td style="padding:6px 12px 0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${overview}</tr></table></td></tr>` +
    // attention
    `<tr><td style="padding:16px 16px 0;${FONT}"><div style="font-size:14px;font-weight:700;color:#111827;margin-bottom:4px;">What needs your attention</div>` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${attHtml}</table></td></tr>` +
    // region cards
    `<tr><td style="padding:16px 16px 0;${FONT}"><div style="font-size:14px;font-weight:700;color:#111827;margin-bottom:2px;">All results, region by region</div>` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${cards}</table></td></tr>` +
    // legend + footer
    `<tr><td style="padding:10px 16px 4px;${FONT}font-size:12px;color:#4b5563;">🟢 Normal &nbsp;&nbsp; 🟠 Unusual, take a look &nbsp;&nbsp; 🔴 Critical &nbsp;&nbsp; ⚪ No result` +
    `<div style="margin-top:6px;font-size:11.5px;line-height:16px;color:#6b7280;"><b>Ping</b> = how fast and how reliably each data centre reaches the internet. <b>Speed</b> = download, upload and delay between ${cloudSpeed() ? 'the cloud server' : 'the office network'} and each data centre. &ldquo;Usual&rdquo; means the normal value of the last 7 days.</div></td></tr>` +
    (dash ? `<tr><td style="padding:10px 16px 4px;"><a href="${esc(dash)}" style="display:inline-block;background:#0F4761;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700;${FONT}">Open the dashboard</a></td></tr>` : '') +
    `<tr><td style="padding:12px 16px 14px;${FONT}font-size:11px;color:#9ca3af;border-top:1px solid #f3f4f6;">Automated message, sent once a day. A red critical alert is sent separately only when 5 or more ping requests in a row time out in a region.</td></tr>` +
    `</table></div>`;
  return { subject, html, text };
}

/* ------------------------------ the daily job ------------------------------ */

export async function runDailyCheck(deps: DailyDeps, opts: { force?: boolean } = {}) {
  const since = Date.now();
  // 1. run all tests (ping + speed) and 2. wait until every region has reported. Only then the e-mail is built and sent.
  const [pingRes, speed] = await Promise.all([
    deps.runPings(),
    cloudSpeed() ? runSpeedRound() : Promise.resolve({ samples: new Map<string, Sample>(), errors: new Map<string, string>() }),
  ]);
  await waitForScheduledPing(pingRes.filter((r) => r.status === 'queued').map((r) => r.region), since, since + maxWaitMs());
  const report = await buildReport(since, pingRes, speed);
  const mail = buildMail(report, new Date());

  // exactly one summary e-mail per day (IST), even if the job is started twice; ?force=1 skips this check
  let emailStatus: string;
  const to = alertRecipients();
  if (!process.env.RESEND_API_KEY?.trim() || !to.length) {
    emailStatus = 'not_configured';
  } else {
    const dayKey = `daily:mail:${istDay(new Date())}`;
    let locked = false;
    let duplicate = false;
    if (redisConfig() && !opts.force) {
      try {
        const [set] = await redisPipeline([['SET', dayKey, '1', 'NX', 'EX', 20 * 3600]]);
        if (set === 'OK') locked = true; else duplicate = true;
      } catch { /* storage problem: better to send than to stay silent */ }
    }
    if (duplicate) {
      emailStatus = 'already_sent_today';
    } else {
      const s = await sendEmailViaResend(to, mail);
      if (s !== 'sent' && locked) await redisPipeline([['DEL', dayKey]]).catch(() => undefined); // allow a retry
      emailStatus = s;
    }
  }

  if (redisConfig()) {
    await redisPipeline([['SET', DAILY_LAST_KEY, JSON.stringify({ t: Date.now(), overall: report.overall, email: emailStatus }), 'EX', 40 * 86400]]).catch(() => undefined);
  }
  return { overall: report.overall, email: emailStatus, regions: report.rows.map((r) => ({ region: r.region, status: r.status, ping: r.ping, speed: r.speed })) };
}
