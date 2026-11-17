/**
 * GET /api/client-info
 *
 * Tells the browser WHERE THE PERSON RUNNING THE SPEED TEST IS CONNECTING FROM (the "source" of the test),
 * so every result can read "<this location>  ->  <data center>".
 *
 * How the location is found (all from the visitor's public IP address):
 *   1. The IP itself: x-forwarded-for / x-real-ip (set by Vercel, which overwrites any value the client sends).
 *   2. Vercel's own geolocation headers (x-vercel-ip-city, -country, -country-region, -latitude, ...): free, instant.
 *   3. An optional IP lookup (default https://ipwho.is, no key, HTTPS) that adds the ISP / network name and the full
 *      region name. Cached per IP for 6 hours. If it is slow or down, steps 1 and 2 are still returned.
 *
 * Safety:
 *   - The endpoint takes NO parameters. It only ever describes the caller's own connection, so it cannot be used to
 *     look up somebody else's IP.
 *   - It is rate limited per IP and never cached by the browser or a CDN.
 *
 * Environment (all optional):
 *   GEOIP_LOOKUP=off            turn the ISP lookup off (location then comes from Vercel headers only)
 *   GEOIP_LOOKUP_URL=<url>      another provider; "{ip}" is replaced by the IP. Default: https://ipwho.is/{ip}
 *
 * Accuracy: IP geolocation is city-level at best. Behind a VPN, a corporate proxy or a mobile network it shows where the
 * connection EXITS to the internet, which can be another city. The UI therefore lets the operator correct the label.
 */
import type { Request, Router } from 'express';

export interface ClientInfo {
  ok: true;
  ip: string | null;
  isPrivate: boolean;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  isp: string | null;
  asn: string | null;
  /** which sources produced this answer */
  via: 'vercel+lookup' | 'vercel' | 'lookup' | 'none';
  detectedAt: string;
}

type Geo = Partial<Pick<ClientInfo, 'city' | 'region' | 'country' | 'countryCode' | 'latitude' | 'longitude' | 'timezone' | 'isp' | 'asn'>> & { ip?: string | null };

/* ----------------------------------------------------------------- IP helpers */

/** "::ffff:203.0.113.9" -> "203.0.113.9", "203.0.113.9:5521" -> "203.0.113.9", "[2001:db8::1]" -> "2001:db8::1" */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = String(raw).trim();
  if (!ip || ip === 'unknown-client') return null;
  ip = ip.replace(/^\[|\]$/g, '');
  if (/^::ffff:/i.test(ip)) ip = ip.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.split(':')[0];
  return ip || null;
}

/** Loopback, LAN, link-local and carrier-grade-NAT addresses cannot be located from the internet. */
export function isPrivateIp(ip: string | null): boolean {
  if (!ip) return true;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd');
}

/* ----------------------------------------------------------- location sources */

const header = (h: Request['headers'], name: string): string | null => {
  const v = h[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
};
const decode = (s: string | null): string | null => {
  if (!s) return null;
  try { return decodeURIComponent(s); } catch { return s; }
};
const num = (s: string | null | undefined): number | null => {
  const n = Number(s);
  return s !== null && s !== undefined && s !== '' && Number.isFinite(n) ? n : null;
};

let regionNames: Intl.DisplayNames | null = null;
export function countryName(code: string | null): string | null {
  if (!code) return null;
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch { return code; }
}

/** Vercel adds these to every request on its network. City names arrive percent-encoded ("S%C3%A3o%20Paulo"). */
export function fromVercelHeaders(h: Request['headers']): Geo | null {
  const countryCode = header(h, 'x-vercel-ip-country')?.toUpperCase() ?? null;
  const city = decode(header(h, 'x-vercel-ip-city'));
  if (!countryCode && !city) return null;
  return {
    city,
    region: decode(header(h, 'x-vercel-ip-country-region')), // a code such as "KA"; the lookup (if any) replaces it by the name
    country: countryName(countryCode),
    countryCode,
    latitude: num(header(h, 'x-vercel-ip-latitude')),
    longitude: num(header(h, 'x-vercel-ip-longitude')),
    timezone: header(h, 'x-vercel-ip-timezone'),
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Understands ipwho.is (default) and the common field names of other providers (ipapi.co, ipinfo-style, ip-api). */
export function parseLookup(j: any): Geo | null {
  if (!j || typeof j !== 'object' || j.success === false || j.error === true || j.status === 'fail') return null;
  const conn = j.connection && typeof j.connection === 'object' ? j.connection : {};
  const out: Geo = {
    ip: str(j.ip) ?? str(j.query),
    city: str(j.city),
    region: str(j.region) ?? str(j.regionName) ?? str(j.region_name),
    country: str(j.country) ?? str(j.country_name),
    countryCode: (str(j.country_code) ?? str(j.countryCode))?.toUpperCase() ?? null,
    latitude: num(String(j.latitude ?? j.lat ?? '')),
    longitude: num(String(j.longitude ?? j.lon ?? j.lng ?? '')),
    timezone: str(j.timezone?.id) ?? str(j.timezone),
    isp: str(conn.isp) ?? str(conn.org) ?? str(j.isp) ?? str(j.org),
    asn: conn.asn ? `AS${String(conn.asn).replace(/^AS/i, '')}` : str(j.asn),
  };
  return out.city || out.country || out.countryCode || out.isp ? out : null;
}

/* ------------------------------------------------------------- lookup + cache */

const CACHE_MS = 6 * 3_600_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: Geo | null }>();
export function clearClientInfoCache(): void { cache.clear(); }

async function lookup(ip: string): Promise<Geo | null> {
  if (process.env.GEOIP_LOOKUP?.toLowerCase() === 'off') return null;
  const key = ip || 'self';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value: Geo | null = null;
  try {
    const tpl = process.env.GEOIP_LOOKUP_URL?.trim() || 'https://ipwho.is/{ip}';
    const res = await fetch(tpl.replace('{ip}', encodeURIComponent(ip)), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3500) });
    if (res.ok) value = parseLookup(await res.json());
  } catch { /* slow or unreachable: the Vercel headers still answer */ }
  if (cache.size >= CACHE_MAX && !cache.has(key)) cache.delete(cache.keys().next().value as string);
  if (value) {
    cache.set(key, { at: Date.now(), value });
    return value;
  }
  // Failed: keep the last known answer (if any) and try again in one minute instead of on every request.
  cache.set(key, { at: Date.now() - CACHE_MS + 60_000, value: hit?.value ?? null });
  return hit?.value ?? null;
}

/** Vercel gives location without an ISP; the lookup gives both. Location prefers Vercel, the region name prefers the lookup. */
export function mergeGeo(ip: string | null, isPrivate: boolean, h: Geo | null, l: Geo | null): ClientInfo {
  const sameCountry = !!h && !!l && (!h.countryCode || !l.countryCode || h.countryCode === l.countryCode);
  const base = h ?? l;
  return {
    ok: true,
    ip: isPrivate ? (l?.ip ?? null) : ip,
    isPrivate: isPrivate && !l?.ip,
    city: base?.city ?? l?.city ?? null,
    region: (sameCountry ? l?.region : null) ?? base?.region ?? null,
    country: base?.country ?? l?.country ?? countryName(base?.countryCode ?? null),
    countryCode: base?.countryCode ?? l?.countryCode ?? null,
    latitude: base?.latitude ?? l?.latitude ?? null,
    longitude: base?.longitude ?? l?.longitude ?? null,
    timezone: base?.timezone ?? l?.timezone ?? null,
    isp: l?.isp ?? null,
    asn: l?.asn ?? null,
    via: h && l ? 'vercel+lookup' : h ? 'vercel' : l ? 'lookup' : 'none',
    detectedAt: new Date().toISOString(),
  };
}

/* ---------------------------------------------------------------------- route */

const hits = new Map<string, { n: number; reset: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) {
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  return ++h.n > 30;
}

export function registerClientInfoRoutes(apiRouter: Router, getClientIp: (req: Request) => string): void {
  apiRouter.get('/client-info', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ip = normalizeIp(getClientIp(req));
    if (limited(ip ?? 'unknown')) {
      res.status(429).json({ ok: false, error: 'Too many location checks. Please wait a minute.' });
      return;
    }
    const priv = isPrivateIp(ip);
    const fromHeaders = fromVercelHeaders(req.headers);
    // A private IP means the server is running on the same machine / LAN as the browser (local development):
    // asking the provider about "myself" then returns this machine's public address, which is the right answer for a demo.
    const fromLookup = await lookup(priv ? '' : (ip as string));
    res.json(mergeGeo(ip, priv, fromHeaders, fromLookup));
  });
}
