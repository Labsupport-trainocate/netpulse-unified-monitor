/**
 * The SOURCE of a speed test: where the person who pressed "Start" is connecting from.
 *
 * The browser asks our own backend (GET /api/client-info), which resolves the visitor's public IP to a city / region /
 * country / ISP. IP location is approximate (it can show where a VPN or office network exits to the internet), so the
 * operator may correct the label; the correction is remembered in this browser and marked "edited" everywhere.
 */
import type { SpeedSource } from '../types/speedSession';

const OVERRIDE_KEY = 'netpulse_source_label_v1';

export type SourceView =
  | { state: 'loading' }
  | { state: 'ready'; source: SpeedSource }
  | { state: 'unavailable'; reason: string };

const unique = (parts: Array<string | null | undefined>): string[] => {
  const out: string[] = [];
  for (const p of parts) {
    const t = (p || '').trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
};

/** A region that is only a code ("KA", "TN") reads badly in a label, so it is left out; full names ("Karnataka") are kept. */
const isRegionCode = (r: string | null): boolean => !!r && /^[A-Z0-9]{1,3}$/.test(r.trim());

export const buildLabel = (i: { city: string | null; region: string | null; country: string | null }): string =>
  unique([i.city, isRegionCode(i.region) ? null : i.region, i.country]).join(', ') || 'Unknown location';

/** Short form for tight spaces: "Bengaluru, India". */
export const shortLabel = (s: Pick<SpeedSource, 'label' | 'city' | 'country' | 'edited'>): string =>
  s.edited ? s.label : unique([s.city, s.country]).join(', ') || s.label;

export function readOverride(): string | null {
  try {
    return window.localStorage.getItem(OVERRIDE_KEY)?.trim().slice(0, 80) || null;
  } catch {
    return null;
  }
}

export function writeOverride(label: string | null): void {
  try {
    const v = (label || '').trim().slice(0, 80);
    if (v) window.localStorage.setItem(OVERRIDE_KEY, v);
    else window.localStorage.removeItem(OVERRIDE_KEY);
  } catch { /* private mode: the correction simply lasts until the page is closed */ }
}

/** Puts the operator's correction (if any) on top of what was detected. */
export function withOverride(detected: SpeedSource, override: string | null): SpeedSource {
  return override ? { ...detected, label: override, edited: true } : { ...detected, edited: false };
}

/** Asks the backend. Throws a readable Error when the answer is unusable. */
export async function detectSource(): Promise<SpeedSource> {
  const res = await fetch('/api/client-info', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(res.status === 429 ? 'Too many location checks, try again in a minute.' : `Location service answered HTTP ${res.status}.`);
  const j = await res.json();
  if (!j || j.ok !== true) throw new Error(j?.error || 'Location service returned no data.');
  const hasPlace = j.city || j.region || j.country;
  if (!hasPlace && !j.ip) throw new Error('Your location could not be determined from your network address.');
  return {
    label: hasPlace ? buildLabel(j) : `Unknown location (${j.ip})`,
    city: j.city ?? null,
    region: j.region ?? null,
    country: j.country ?? null,
    countryCode: j.countryCode ?? null,
    ip: j.ip ?? null,
    isp: j.isp ?? null,
    asn: j.asn ?? null,
    edited: false,
    via: j.via ?? 'none',
    detectedAt: j.detectedAt ?? new Date().toISOString(),
  };
}

/** "Bangalore, Karnataka" + country "India" -> "Bangalore, Karnataka, India" (no repeat when the country is already in it). */
export function destinationLabel(location: string | undefined, country: string | undefined): string {
  const loc = (location || '').trim();
  const c = (country || '').trim();
  if (!loc) return c || 'Unknown';
  return c && !loc.toLowerCase().includes(c.toLowerCase()) ? `${loc}, ${c}` : loc;
}
