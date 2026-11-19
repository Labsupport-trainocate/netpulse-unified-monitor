import { getSamples, getMonthlyReports, saveMonthlyReport, REGIONS, type Sample } from './metricsStore.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const median = (values: number[]) => { const a = [...values].sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const cv = (values: number[]) => { const avg = mean(values); if (avg === null || avg === 0 || values.length < 2) return null; const sd = Math.sqrt(mean(values.map(v => (v - avg) ** 2)) || 0); return sd / avg; };
const metricValue = (samples: Sample[], metric: string) => samples.map(s => s.m[metric]).filter((v): v is number => Number.isFinite(v));
const clamp = (n: number) => Math.max(0, Math.min(100, n));

export interface MonthlyRegionResult {
  region: string; eligible: boolean; sampleCounts: { speed: number; ping: number }; score: number | null; rank: number | null;
  metrics: Record<string, number | null>; dimensions: Record<string, number | null>; strengths: string[]; weaknesses: string[]; recommendations: string[];
  trend: 'improving' | 'degrading' | 'inconsistent' | 'insufficient-history' | 'stable';
}
export interface MonthlyReport {
  id: string; month: string; generatedAt: number; status: 'complete' | 'insufficient-data'; methodology: string;
  winner: string | null; weakest: string | null; consecutiveWinnerMonths: number; regions: MonthlyRegionResult[];
  ranking: Array<{ region: string; score: number; rank: number }>; dataCoverage: { eligibleRegions: number; totalRegions: number };
}

function monthBounds(month: string) {
  if (!MONTH_RE.test(month)) throw new Error('month must use YYYY-MM.');
  const [y, m] = month.split('-').map(Number);
  const from = Date.UTC(y, m - 1, 1); const to = Date.UTC(y, m, 1) - 1;
  if (to >= Date.now()) throw new Error('Monthly reports can only be generated after the month has ended.');
  return { from, to };
}

function scoreDimension(values: Array<{ region: string; value: number | null }>, higherBetter: boolean) {
  const valid = values.filter(x => x.value !== null) as Array<{ region: string; value: number }>;
  if (!valid.length) return new Map<string, number>();
  const lo = Math.min(...valid.map(x => x.value)); const hi = Math.max(...valid.map(x => x.value));
  return new Map(valid.map(x => [x.region, hi === lo ? 100 : clamp(((higherBetter ? x.value - lo : hi - x.value) / (hi - lo)) * 100)]));
}

export function buildMonthlyReport(month: string, speedSamples: Sample[], pingSamples: Sample[], priorReports: any[]): MonthlyReport {
  const raw = REGIONS.map(region => {
    const sp = speedSamples.filter(s => s.region === region); const pi = pingSamples.filter(s => s.region === region);
    const dl = median(metricValue(sp, 'downloadMbps')); const ul = median(metricValue(sp, 'uploadMbps'));
    const speedJitter = median(metricValue(sp, 'jitterMs')); const latency = median(metricValue(pi, 'avgLatencyMs'));
    const pingJitter = median(metricValue(pi, 'jitterMs')); const loss = mean(metricValue(pi, 'packetLossPercent'));
    const jitter = speedJitter === null ? pingJitter : pingJitter === null ? speedJitter : (speedJitter + pingJitter) / 2;
    const stabilityCv = [cv(metricValue(sp, 'downloadMbps')), cv(metricValue(pi, 'avgLatencyMs'))].filter((v): v is number => v !== null);
    const stability = stabilityCv.length ? clamp(100 - mean(stabilityCv)! * 100) : null;
    const metrics = { downloadMbps: dl, uploadMbps: ul, avgLatencyMs: latency, jitterMs: jitter, packetLossPercent: loss, stabilityScore: stability };
    const eligible = sp.length >= 3 && pi.length >= 3 && dl !== null && ul !== null && latency !== null && jitter !== null && loss !== null && stability !== null;
    return { region, sp, pi, metrics, eligible };
  });
  const keys: Array<[keyof typeof raw[number]['metrics'], boolean, number]> = [
    ['downloadMbps', true, 20], ['uploadMbps', true, 15], ['avgLatencyMs', false, 20], ['jitterMs', false, 15], ['packetLossPercent', false, 15], ['stabilityScore', true, 15],
  ];
  const allRegionsEligible = raw.every(x => x.eligible);
  const dimensionMaps = new Map<string, Map<string, number>>();
  for (const [key, high] of keys) dimensionMaps.set(key, scoreDimension(raw.map(x => ({ region: x.region, value: x.eligible ? x.metrics[key] : null })), high));
  const scored = raw.map(x => {
    const dimensions: Record<string, number | null> = {};
    for (const [key] of keys) dimensions[key] = dimensionMaps.get(key)?.get(x.region) ?? null;
    const score = x.eligible && allRegionsEligible ? Math.round(keys.reduce((sum, [key, , weight]) => sum + (dimensions[key] ?? 0) * weight, 0) / 100) : null;
    const strengths: string[] = []; const weaknesses: string[] = []; const recommendations: string[] = [];
    if (x.eligible && allRegionsEligible) {
      if ((dimensions.downloadMbps ?? 0) >= 75) strengths.push('Strong download throughput'); else if ((dimensions.downloadMbps ?? 0) < 40) { weaknesses.push('Download throughput'); recommendations.push('Review available bandwidth, link utilization and ISP capacity.'); }
      if ((dimensions.uploadMbps ?? 0) >= 75) strengths.push('Strong upload throughput'); else if ((dimensions.uploadMbps ?? 0) < 40) { weaknesses.push('Upload throughput'); recommendations.push('Review upstream capacity and congestion during busy periods.'); }
      if ((dimensions.avgLatencyMs ?? 0) >= 75) strengths.push('Low average latency'); else if ((dimensions.avgLatencyMs ?? 0) < 40) { weaknesses.push('Average latency'); recommendations.push('Review routing path, peering and congestion to reduce round-trip time.'); }
      if ((dimensions.jitterMs ?? 0) < 40) { weaknesses.push('Jitter'); recommendations.push('Investigate variable delay and queueing on the regional link.'); } else if ((dimensions.jitterMs ?? 0) >= 75) strengths.push('Consistent packet timing');
      if ((dimensions.packetLossPercent ?? 0) < 40) { weaknesses.push('Packet loss'); recommendations.push('Inspect interface errors, drops and upstream packet loss.'); } else if ((dimensions.packetLossPercent ?? 0) >= 75) strengths.push('Low packet loss');
      if ((dimensions.stabilityScore ?? 0) < 40) { weaknesses.push('Performance consistency'); recommendations.push('Compare peak/off-peak behavior and investigate intermittent utilization spikes.'); } else if ((dimensions.stabilityScore ?? 0) >= 75) strengths.push('Consistent performance');
    } else if (!x.eligible) recommendations.push('Insufficient measurements for a reliable monthly score; collect at least three speed and three ping samples with all required metrics.');
    else recommendations.push('This region has enough samples, but the monthly ranking is withheld until all four regions meet the minimum data requirement.');
    const previous = priorReports.slice(-3).map(r => r.regions?.find((z: any) => z.region === x.region)?.score).filter((v: any) => typeof v === 'number');
    const trendSpread = previous.length >= 2 ? cv(previous) : null;
    const trend = score === null || previous.length < 2 ? 'insufficient-history' : trendSpread !== null && trendSpread > 0.15 ? 'inconsistent' : (score - previous[previous.length - 1] > 5 ? 'improving' : score - previous[previous.length - 1] < -5 ? 'degrading' : 'stable');
    return { region: x.region, eligible: x.eligible, sampleCounts: { speed: x.sp.length, ping: x.pi.length }, score, rank: null, metrics: x.metrics, dimensions, strengths, weaknesses, recommendations, trend } as MonthlyRegionResult;
  });
  const ranking = allRegionsEligible ? scored.filter(x => x.score !== null).sort((a, b) => (b.score! - a.score!)).map((x, i) => ({ region: x.region, score: x.score!, rank: i + 1 })) : [];
  ranking.forEach(x => { const row = scored.find(r => r.region === x.region)!; row.rank = x.rank; });
  const winner = ranking[0]?.region || null; const weakest = ranking.length ? ranking[ranking.length - 1].region : null;
  let streak = 0;
  if (winner) {
    const [year, monthNumber] = month.split('-').map(Number);
    const priorDate = new Date(Date.UTC(year, monthNumber - 2, 1));
    let expectedMonth = `${priorDate.getUTCFullYear()}-${String(priorDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const previousChronological = [...priorReports].sort((a, b) => String(a.month).localeCompare(String(b.month))).reverse();
    for (const prior of previousChronological) {
      if (prior.month !== expectedMonth || prior.winner !== winner) break;
      streak++; priorDate.setUTCMonth(priorDate.getUTCMonth() - 1);
      expectedMonth = `${priorDate.getUTCFullYear()}-${String(priorDate.getUTCMonth() + 1).padStart(2, '0')}`;
    }
  }
  return { id: `monthly-${month}`, month, generatedAt: Date.now(), status: allRegionsEligible && ranking.length === REGIONS.length ? 'complete' : 'insufficient-data', methodology: 'Weighted relative monthly score: download 20%, upload 15%, average latency 20%, jitter 15%, packet loss 15%, and stability 15%. Speed/quality metrics are normalized against the four regions for the same month. Each region requires at least 3 speed and 3 ping samples with all scored metrics present; incomplete regions are not ranked.', winner, weakest, consecutiveWinnerMonths: winner ? streak + 1 : 0, regions: scored, ranking, dataCoverage: { eligibleRegions: raw.filter(x => x.eligible).length, totalRegions: REGIONS.length } };
}

export async function getStoredMonthlyReport(month: string) {
  const reports = await getMonthlyReports(Date.UTC(2000, 0, 1), Date.now() + 1000, 60);
  return reports.find(r => r.month === month) || null;
}
export async function generateAndStoreMonthlyReport(requestedMonth?: string): Promise<MonthlyReport> {
  const now = new Date(); const priorMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const month = requestedMonth || `${priorMonthDate.getUTCFullYear()}-${String(priorMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const existing = await getStoredMonthlyReport(month); if (existing) return existing as MonthlyReport;
  const { from, to } = monthBounds(month);
  const [speed, ping, reports] = await Promise.all([getSamples('speed', 'all', from, to, 20000), getSamples('ping', 'all', from, to, 20000), getMonthlyReports(Date.UTC(2000, 0, 1), from - 1, 36)]);
  const report = buildMonthlyReport(month, speed, ping, reports);
  await saveMonthlyReport(report);
  return report;
}
