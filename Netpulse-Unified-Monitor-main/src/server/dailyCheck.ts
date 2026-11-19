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
interface Row { region: string; ping: string; speed: string; jitter: string; status: 'ok' | 'note' | 'critical'; notes: string[] }

const f1 = (v: unknown) => (typeof v === 'number' ? v.toFixed(1) : 'n/a');

async function buildReport(since: number, pingRes: ProbeResult[], speed: Awaited<ReturnType<typeof runSpeedRound>>) {
  const from = since - 60_000;
  const anomalies: StoredAnomaly[] = await getAnomalies(from, Date.now() + 1000, 200).catch(() => []);
  const marks: Array<string | null> = redisConfig()
    ? await redisPipeline(REGIONS.map((r) => ['GET', CRITICAL_MARK_KEY(r)])).catch(() => REGIONS.map(() => null))
    : REGIONS.map(() => null);

  const rows: Row[] = [];
  for (let i = 0; i < REGIONS.length; i++) {
    const region = REGIONS[i];
    const notes: string[] = [];
    let status: Row['status'] = 'ok';

    // ping
    const ps = (await getSamples('ping', region, from, Date.now() + 1000, 20).catch(() => [] as Sample[])).sort((a, b) => b.t - a.t)[0];
    let ping = 'no result';
    if (ps) {
      ping = `avg ${f1(ps.m.avgLatencyMs)} ms, loss ${f1(ps.m.packetLossPercent ?? 0)} %`;
      if ((ps.m.packetLossPercent ?? 0) > 0) notes.push(`Ping: ${f1(ps.m.packetLossPercent)} % of requests timed out (below the critical limit of consecutive timeouts).`);
    } else {
      const pr = pingRes.find((x) => x.region === region);
      const why = pr?.status === 'agent_offline' ? 'the regional ping agent is offline'
        : pr?.status === 'queued' ? `the agent did not report back within ${Math.round(maxWaitMs() / 1000)} seconds`
        : pr?.status === 'skipped' ? (pr.detail || 'no ping source is configured for this region')
        : pr?.detail || 'no result was received';
      notes.push(`Ping was not tested: ${why}.`);
    }

    // speed
    const ss = speed.samples.get(region);
    let spd = 'no result';
    let jitter = 'n/a';
    if (ss) {
      spd = `down ${f1(ss.m.downloadMbps)} / up ${f1(ss.m.uploadMbps)} Mbps, ping ${f1(ss.m.pingMs)} ms`;
      jitter = `${f1(ss.m.jitterMs)} ms`;
      if (ss.m.downloadMbps === undefined || ss.m.uploadMbps === undefined) notes.push('Speed test: download or upload could not be measured.');
    } else {
      notes.push(`Speed test did not complete: ${speed.errors.get(region) || 'no result'}.`);
    }

    // anomalies found by this run (shown on the dashboard, never e-mailed separately)
    for (const a of anomalies.filter((x) => x.region === region)) notes.push(`Unusual value: ${a.message}`);

    if (notes.length) status = 'note';
    let mark: any = null;
    try { mark = marks[i] ? JSON.parse(marks[i] as string) : null; } catch { /* ignore */ }
    if (mark && typeof mark.t === 'number' && mark.t >= from) {
      status = 'critical';
      notes.unshift(`CRITICAL: ${mark.maxRun} ping requests in a row timed out. The red critical alert e-mail was sent for this region.`);
    }
    rows.push({ region, ping, speed: spd, jitter, status, notes });
  }
  const overall: Overall = rows.some((r) => r.status === 'critical') ? 'critical' : rows.some((r) => r.status === 'note') ? 'notes' : 'good';
  return { rows, overall };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const istDate = (d: Date) => d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const istDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD

function buildMail(report: { rows: Row[]; overall: Overall }, now: Date) {
  const day = istDate(now);
  const title = report.overall === 'good' ? 'Everything is good'
    : report.overall === 'notes' ? 'Completed with notes'
    : 'Critical alert raised - please check';
  const subject = `Daily Network Check - ${day}: ${title}`;
  const dash = process.env.ALERT_DASHBOARD_URL?.trim() || '';
  const pill = report.overall === 'good' ? ['#dcfce7', '#166534'] : report.overall === 'notes' ? ['#fef3c7', '#92400e'] : ['#fee2e2', '#991b1b'];
  const intro = report.overall === 'good'
    ? 'All four regional ping and speed checks completed normally. No action is required.'
    : report.overall === 'notes'
      ? 'The daily checks are complete. No critical issue was detected, but the highlighted items below are worth reviewing.'
      : 'A critical ping failure was detected today. Review the affected region and the separate critical alert email.';
  const notes = report.rows.flatMap((r) => r.notes.map((n) => `${r.region}: ${n}`));

  const text = [
    `NETWORK MONITOR - DAILY CHECK (${day})`, '', title.toUpperCase(), intro, '',
    ...report.rows.map((r) => `${r.region} (${REGION_NAMES[r.region] || ''}) - ${r.status === 'ok' ? 'HEALTHY' : r.status === 'note' ? 'REVIEW' : 'CRITICAL'}\n  PING MONITORING: ${r.ping}\n  SPEED TEST: ${r.speed}`),
    ...(notes.length ? ['', 'Items to review:', ...notes.map((n) => `- ${n}`)] : []),
    ...(dash ? ['', `Dashboard: ${dash}`] : []), '',
    'Automated daily report. A separate critical alert is sent when the configured consecutive ping-timeout threshold is reached.',
  ].join('\n');

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const regionMeta: Record<string, { place: string }> = {
    'IN-DC01': { place: 'Bangalore · TATA' },
    'IN-DC02': { place: 'Bangalore · ACT' },
    'LK-DC01': { place: 'Sri Lanka' },
    'SG-DC01': { place: 'Singapore' },
  };
  const statusMeta = (status: Row['status']) => status === 'ok'
    ? { label: 'HEALTHY', color: '#15803d', bg: '#dcfce7' }
    : status === 'note'
      ? { label: 'REVIEW', color: '#b45309', bg: '#fef3c7' }
      : { label: 'CRITICAL', color: '#b91c1c', bg: '#fee2e2' };

  // Email-safe segmented ring gauges. Conic gradients are ignored by some
  // email clients, so the progress ring is built from coloured table-cell dots.
  // This keeps the centre white and displays the measured progress in Outlook too.
  const metricCircle = (label: string, value: string, fill: string, width: string, progress = 100) => {
    const pct = Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0));
    const gridSize = 21;
    const center = 10;
    const ringCells: Array<{ row: number; col: number; angle: number }> = [];
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const dx = col - center;
        const dy = row - center;
        const radius = Math.sqrt(dx * dx + dy * dy);
        if (radius >= 10.0 && radius <= 11.2) {
          const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
          ringCells.push({ row, col, angle });
        }
      }
    }
    const orderedRing = [...ringCells].sort((a, b) => a.angle - b.angle);
    const filledCount = Math.round((pct / 100) * orderedRing.length);
    const ringLookup = new Map(orderedRing.map((cell, index) => [`${cell.row},${cell.col}`, index]));
    const centerMarkup =
      `<table role="presentation" width="90" height="90" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="width:90px;height:90px;border:1px solid #ffffff;border-radius:50%;background:#ffffff;border-collapse:separate">` +
        `<tr><td align="center" valign="middle" style="padding:5px 2px">` +
          `<div style="font-size:10px;line-height:1.2;letter-spacing:.25px;color:#334155;font-weight:700;text-transform:uppercase">${label}</div>` +
          `<div style="font-size:16px;line-height:1.2;color:#172033;font-weight:800;margin-top:6px;white-space:nowrap">${esc(value)}</div>` +
        `</td></tr>` +
      `</table>`;
    const gridCell = (row: number, col: number) => {
      const ringIndex = ringLookup.get(`${row},${col}`);
      if (ringIndex !== undefined) {
        const dotColor = ringIndex < filledCount ? fill : '#e8edf2';
        return `<td width="6" height="6" align="center" valign="middle" style="width:6px;height:6px;padding:0;font-size:0;line-height:0"><table role="presentation" width="6" height="6" cellspacing="0" cellpadding="0"><tr><td width="6" height="6" bgcolor="${dotColor}" style="width:6px;height:6px;background:${dotColor};font-size:0;line-height:0;border-radius:50%">&nbsp;</td></tr></table></td>`;
      }
      return `<td width="6" height="6" style="width:6px;height:6px;padding:0;font-size:0;line-height:0"></td>`;
    };
    let gridRows = '';
    for (let row = 0; row < gridSize; row++) {
      let rowCells = '';
      if (row === 3) {
        rowCells += `<td colspan="15" rowspan="15" width="90" height="90" align="center" valign="middle" bgcolor="#ffffff" style="width:90px;height:90px;padding:0;background:#ffffff;border-radius:50%">${centerMarkup}</td>`;
        for (let col = 0; col < 3; col++) rowCells += gridCell(row, col);
        for (let col = 18; col < 21; col++) rowCells += gridCell(row, col);
      } else if (row >= 4 && row <= 17) {
        for (let col = 0; col < 3; col++) rowCells += gridCell(row, col);
        for (let col = 18; col < 21; col++) rowCells += gridCell(row, col);
      } else {
        for (let col = 0; col < gridSize; col++) {
          const ringIndex = ringLookup.get(`${row},${col}`);
          if (ringIndex !== undefined) {
            const dotColor = ringIndex < filledCount ? fill : '#e8edf2';
            rowCells += `<td width="6" height="6" align="center" valign="middle" style="width:6px;height:6px;padding:0;font-size:0;line-height:0"><table role="presentation" width="6" height="6" cellspacing="0" cellpadding="0"><tr><td width="6" height="6" bgcolor="${dotColor}" style="width:6px;height:6px;background:${dotColor};font-size:0;line-height:0;border-radius:50%">&nbsp;</td></tr></table></td>`;
          } else {
            rowCells += `<td width="6" height="6" style="width:6px;height:6px;padding:0;font-size:0;line-height:0"></td>`;
          }
        }
      }
      gridRows += `<tr height="6" style="height:6px">${rowCells}</tr>`;
    }
    return `<td width="${width}" align="center" valign="top" style="padding:8px 3px 12px"><table role="presentation" align="center" width="126" height="126" cellspacing="0" cellpadding="0" style="width:126px;height:126px;border-collapse:collapse">${gridRows}</table></td>`;
  };
  const pingFill = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return '#cbd5e1';
    if (n > 140) return '#f0a3a8';
    if (n >= 80) return '#f3d58a';
    if (n < 60) return '#9bd8b2';
    return '#cbd5e1';
  };
  const speedFill = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return '#cbd5e1';
    if (n < 10) return '#f0a3a8';
    if (n < 25) return '#f3d58a';
    return '#9bd8b2';
  };
  const speedCapacityMbps: Record<string, number> = { 'IN-DC01': 100, 'IN-DC02': 100, 'LK-DC01': 200, 'SG-DC01': 200 };

  const regionHeader = (r: Row) => {
    const meta = regionMeta[r.region] || { place: REGION_NAMES[r.region] || '' };
    const st = statusMeta(r.status);
    return `<tr><td style="padding:14px 4px 5px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td valign="middle"><div style="font-size:15px;font-weight:800;color:#0f172a">${esc(r.region)}</div><div style="font-size:11px;color:#64748b;margin-top:3px">${esc(meta.place)}</div></td><td align="right" valign="middle"><span style="display:inline-block;padding:5px 10px;border-radius:20px;background:${st.bg};color:${st.color};font-size:10px;font-weight:800;letter-spacing:.4px">${st.label}</span></td></tr></table></td></tr>`;
  };

  const pingCards = report.rows.map((r, index) => {
    const ping = r.ping.match(/avg\s+([\d.]+)\s*ms,\s*loss\s+([\d.]+)\s*%/i);
    const pingValue = ping ? `${ping[1]} ms` : 'No result';
    const lossValue = ping ? `${ping[2]}%` : '—';
    return `<tr><td style="padding:0 0 9px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${regionHeader(r)}<tr><td><table role="presentation" align="center" width="100%" cellspacing="0" cellpadding="0"><tr>${metricCircle('Average ping', pingValue, ping ? pingFill(ping[1]) : '#cbd5e1', '50%', ping ? (Number(ping[1]) / 200) * 100 : 0)}${metricCircle('Packet loss', lossValue, ping ? (Number(ping[2]) === 0 ? '#9bd8b2' : '#f0a3a8') : '#cbd5e1', '50%', ping ? (Number(ping[2]) / 10) * 100 : 0)}</tr></table></td></tr><tr><td style="border-bottom:${index === report.rows.length - 1 ? '0' : '1px solid #e2e8f0'};font-size:1px;line-height:1px">&nbsp;</td></tr></table></td></tr>`;
  }).join('');

  const speedCards = report.rows.map((r, index) => {
    const speed = r.speed.match(/down\s+([\d.]+)\s*\/\s*up\s+([\d.]+)\s*Mbps,\s*ping\s+([\d.]+)\s*ms/i);
    const downValue = speed ? `${speed[1]} Mbps` : 'No result';
    const upValue = speed ? `${speed[2]} Mbps` : 'No result';
    const speedPingValue = speed ? `${speed[3]} ms` : 'No result';
    const capacity = speedCapacityMbps[r.region] || 100;
    const downloadPct = speed ? (Number(speed[1]) / capacity) * 100 : 0;
    const uploadPct = speed ? (Number(speed[2]) / capacity) * 100 : 0;
    return `<tr><td style="padding:0 0 9px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${regionHeader(r)}<tr><td><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${metricCircle('Download', downValue, speed ? speedFill(speed[1]) : '#cbd5e1', '33.33%', downloadPct)}${metricCircle('Upload', upValue, speed ? speedFill(speed[2]) : '#cbd5e1', '33.33%', uploadPct)}${metricCircle('Ping', speedPingValue, speed ? pingFill(speed[3]) : '#cbd5e1', '33.33%', speed ? (Number(speed[3]) / 200) * 100 : 0)}</tr></table></td></tr><tr><td style="border-bottom:${index === report.rows.length - 1 ? '0' : '1px solid #e2e8f0'};font-size:1px;line-height:1px">&nbsp;</td></tr></table></td></tr>`;
  }).join('');

  const reviewItems = report.rows.flatMap((r) => r.notes.map((n) =>
    `<tr><td style="padding:4px 0;font-size:12px;line-height:1.5;color:#334155"><strong>${esc(r.region)}:</strong> ${esc(n.replace(/^CRITICAL:\s*/i, ''))}</td></tr>`
  ));
  const reviewSection = reviewItems.length
    ? `<tr><td style="padding:12px 18px 16px"><div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:7px">Items to review</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:9px;padding:9px 12px">${reviewItems.join('')}</table></td></tr>`
    : `<tr><td style="padding:10px 18px 15px;font-size:12px;color:#15803d">✓ No unusual values were reported across the regions.</td></tr>`;

  const summary = report.overall === 'good'
    ? { icon: '✓', heading: 'All regions are looking good' }
    : report.overall === 'notes'
      ? { icon: '!', heading: 'A few items need a look' }
      : { icon: '!', heading: 'Critical issue detected' };

  const metricData = report.rows.map((r) => {
    const p = r.ping.match(/avg\s+([\d.]+)\s*ms,\s*loss\s+([\d.]+)\s*%/i);
    const s = r.speed.match(/down\s+([\d.]+)\s*\/\s*up\s+([\d.]+)\s*Mbps,\s*ping\s+([\d.]+)\s*ms/i);
    return { row: r, avgPing: p ? Number(p[1]) : null, loss: p ? Number(p[2]) : null,
      down: s ? Number(s[1]) : null, up: s ? Number(s[2]) : null, speedPing: s ? Number(s[3]) : null };
  });
  const normalCount = report.rows.filter((r) => r.status === 'ok').length;
  const noteCount = report.rows.filter((r) => r.status === 'note').length;
  const criticalCount = report.rows.filter((r) => r.status === 'critical').length;
  const availableLoss = metricData.filter((x) => x.loss !== null);
  const avgLoss = availableLoss.length ? availableLoss.reduce((a, x) => a + (x.loss || 0), 0) / availableLoss.length : null;
  const delivery = avgLoss === null ? null : Math.max(0, 100 - avgLoss);
  const maxMbps = Math.max(1, ...metricData.flatMap((x) => [x.down || 0, x.up || 0]));
  const maxLatency = Math.max(1, ...metricData.flatMap((x) => [x.avgPing || 0, x.speedPing || 0]));
  const bar = (value: number | null, max: number, color: string) => value === null
    ? `<span style="color:#94a3b8;font-size:11px">Not available</span>`
    : `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td width="${Math.max(2, Math.round(value / max * 100))}%" height="11" bgcolor="${color}" style="height:11px;background:${color};border-radius:3px;font-size:0;line-height:0">&nbsp;</td><td></td></tr></table>`;
  const panel = (heading: string, body: string) => `<td valign="top" width="50%" style="padding:7px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dbe7f2;border-radius:10px;background:#ffffff"><tr><td style="padding:13px">${heading}${body}</td></tr></table></td>`;
  const monitoredSites = metricData.map(({ row: r }) => {
    const st = statusMeta(r.status);
    const dot = r.status === 'ok' ? '#22a765' : r.status === 'note' ? '#f0a000' : '#dc4444';
    return `<td width="50%" valign="top" style="padding:5px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dbe7f2;border-radius:8px"><tr><td width="18" valign="top" style="padding:11px 0 9px 10px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dot}">&nbsp;</span></td><td style="padding:9px 4px"><div style="font-size:12px;font-weight:800;color:#10264b">${esc(r.region)}</div><div style="font-size:10px;color:#526b8e;margin-top:3px">${esc((regionMeta[r.region] || { place: '' }).place)}</div></td><td align="right" valign="middle" style="padding:7px 8px"><span style="display:inline-block;background:${st.bg};color:${st.color};font-size:9px;font-weight:800;padding:5px 7px;border-radius:6px">${st.label === 'HEALTHY' ? 'NORMAL' : st.label === 'REVIEW' ? 'WITH NOTES' : 'CRITICAL'}</span></td></tr></table></td>`;
  });
  const siteGrid = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${monitoredSites.slice(0, 2).join('')}</tr><tr>${monitoredSites.slice(2, 4).join('')}</tr></table>`;
  const speedRows = metricData.map(({ row: r, down, up }) => `<tr><td width="92" valign="middle" style="padding:7px 6px 7px 0"><div style="font-size:11px;font-weight:800;color:#10264b">${esc(r.region)}</div><div style="font-size:9px;color:#526b8e">${esc((regionMeta[r.region] || { place: '' }).place)}</div></td><td style="padding:5px 0"><div style="font-size:9px;color:#0d9488;margin-bottom:3px">Download · ${down === null ? '—' : `${f1(down)} Mbps`}</div>${bar(down, maxMbps, '#18aaa4')}<div style="font-size:9px;color:#1685d8;margin:5px 0 3px">Upload · ${up === null ? '—' : `${f1(up)} Mbps`}</div>${bar(up, maxMbps, '#2995e8')}</td></tr>`).join('');
  const latencyRows = metricData.map(({ row: r, avgPing, speedPing }) => `<tr><td width="92" valign="middle" style="padding:7px 6px 7px 0"><div style="font-size:11px;font-weight:800;color:#10264b">${esc(r.region)}</div><div style="font-size:9px;color:#526b8e">${esc((regionMeta[r.region] || { place: '' }).place)}</div></td><td style="padding:5px 0"><div style="font-size:9px;color:#2589db;margin-bottom:3px">Average · ${avgPing === null ? '—' : `${f1(avgPing)} ms`}</div>${bar(avgPing, maxLatency, '#3299e6')}<div style="font-size:9px;color:#d99016;margin:5px 0 3px">Speed test · ${speedPing === null ? '—' : `${f1(speedPing)} ms`}</div>${bar(speedPing, maxLatency, '#f2b43d')}<div style="font-size:9px;color:#64748b;margin-top:5px">Jitter · ${esc(r.jitter)}</div></td></tr>`).join('');
  const reviewDetailed = report.rows.flatMap((r) => r.notes.map((n) => ({ region: r.region, note: n })));
  const reviewBody = reviewDetailed.length ? reviewDetailed.map((x, i) => `<tr><td width="25" valign="top" style="padding:7px 4px"><span style="display:inline-block;width:20px;height:20px;text-align:center;line-height:20px;border-radius:50%;background:#f6b23e;color:#713f12;font-weight:800">${i + 1}</span></td><td style="padding:7px 4px;font-size:11px;line-height:1.45;color:#334e70"><strong style="color:#10264b">${esc(x.region)}</strong><br>${esc(x.note.replace(/^CRITICAL:\s*/i, ''))}</td></tr>`).join('') : `<tr><td style="padding:12px;font-size:11px;color:#15803d">No unusual values were reported across the regions.</td></tr>`;
  const siteStatusBody =const totalSites = report.rows.length;
  const siteStatusBody = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td width="150" align="center" valign="middle">${metricCircle('',`${totalSites}`,normalCount === totalSites? '#22c55e': criticalCount > 0? '#dc2626': '#f59e0b','150',100)}<div style="font-size:11px;color:#64748b;margin-top:-6px">monitored sites</div></td><td valign="middle" style="padding-left:12px"><div style="font-size:12px;color:#334155;margin-bottom:10px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;margin-right:8px;"></span>${normalCount} normal</div><div style="font-size:12px;color:#334155;margin-bottom:10px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f59e0b;margin-right:8px;"></span>${noteCount} with notes</div>${criticalCount > 0? `<div style="font-size:12px;color:#334155"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#dc2626;margin-right:8px;"></span>${criticalCount} critical</div>`: ''}</td></tr></table>; 
  const deliveryPct =delivery === null? 0: Math.max(0, Math.min(100, delivery));const deliveryBody = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td width="150" align="center" valign="middle">${metricCircle('',delivery === null? 'N/A': `${f1(deliveryPct)}%`,'#22c55e','150',deliveryPct)}</td><td valign="middle" style="padding-left:12px"><div style="font-size:24px;font-weight:800;color:#10264b">${delivery === null ? 'N/A' : `${f1(deliveryPct)}%`}</div><div style="font-size:12px;color:#526b8e;margin-top:4px">${avgLoss === null? 'Packet loss unavailable': `${f1(avgLoss)}% average packet loss`}</div><div style="font-size:11px;color:#64748b;margin-top:8px">${availableLoss.length} of ${totalSites} sites reported ping results</div></td></tr></table>`;
  const siteHeading = `<div style="font-size:14px;font-weight:800;color:#10264b;margin-bottom:9px">Monitored sites</div>`;
  const statusHeading =`<div style="font-size:18px;font-weight:800;color:#10264b;margin-bottom:12px">Site status</div>`;
  const deliveryHeading =`<div style="font-size:18px;font-weight:800;color:#10264b;margin-bottom:12px">Packet delivery</div>`;
  const html =
    `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:0 auto;background:#f4f8fc;color:#10264b;padding:12px">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;background:#f4f8fc">` +
    `<tr><td colspan="2" style="padding:12px 10px 16px"><table role="presentation" width="100%"><tr><td><div style="font-size:25px;font-weight:800;line-height:1.15;color:#10264b">Daily Network Check</div><div style="font-size:13px;color:#526b8e;margin-top:4px">${esc(day)}</div></td><td align="right" valign="top"><span style="display:inline-block;background:${pill[0]};color:${pill[1]};padding:8px 12px;border-radius:18px;font-size:11px;font-weight:800">${title.toUpperCase()}</span><div style="font-size:10px;color:#526b8e;margin-top:6px">${report.overall === 'critical' ? 'Critical issue detected.' : 'No critical issues detected.'}</div></td></tr></table></td></tr>` +
    `<tr>${panel(statusHeading, siteStatusBody)}${panel(deliveryHeading, deliveryBody)}</tr>` +
    `<tr><td colspan="2" style="padding:7px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dbe7f2;border-radius:10px;background:#ffffff"><tr><td style="padding:13px">${siteHeading}${siteGrid}</td></tr></table></td></tr>` +
    `<tr>${panel(`<div style="font-size:14px;font-weight:800;color:#10264b;margin-bottom:4px">Download vs Upload</div><div style="font-size:9px;color:#526b8e;margin-bottom:8px">Measured throughput by region</div>`, `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${speedRows}</table>`)}${panel(`<div style="font-size:14px;font-weight:800;color:#10264b;margin-bottom:4px">Latency comparison</div><div style="font-size:9px;color:#526b8e;margin-bottom:8px">Average ping vs speed-test ping</div>`, `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${latencyRows}</table>`)}</tr>` +
    `<tr><td colspan="2" style="padding:7px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #f5d27b;border-radius:10px;background:#fff9e9"><tr><td style="padding:13px"><div style="font-size:14px;font-weight:800;color:#10264b;margin-bottom:7px">Items to review</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${reviewBody}</table></td></tr></table></td></tr>` +
    (dash ? `<tr><td colspan="2" style="padding:12px 7px"><a href="${esc(dash)}" style="display:inline-block;background:#0f4761;color:#ffffff;padding:10px 15px;border-radius:6px;text-decoration:none;font-size:11px;font-weight:700">Open NetPulse dashboard</a></td></tr>` : '') +
    `<tr><td colspan="2" style="padding:12px 10px;background:#eaf1f8;border-top:1px solid #dbe7f2;font-size:10px;line-height:1.5;color:#526b8e">Automated daily report · Tests run once per scheduled check. A separate critical alert is sent when the configured consecutive ping-timeout threshold is reached.</td></tr>` +
    `</table></div>`;
  return { subject, html, text };
}

/* ------------------------------ the daily job ------------------------------ */

export async function runDailyCheck(deps: DailyDeps, opts: { force?: boolean } = {}) {
  const since = Date.now();
  // 1. run all tests (ping + speed) and 2. wait until every region has reported. Only then the e-mail is built and sent.
  const [pingRes, speed] = await Promise.all([deps.runPings(), runSpeedRound()]);
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
