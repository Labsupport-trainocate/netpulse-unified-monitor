/** Where the person who launched the test was connecting from (the SOURCE of every result in the session). */
export interface SpeedSource {
  /** What is shown: "Bengaluru, Karnataka, India", or the text the operator typed if they corrected it. */
  label: string;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  ip: string | null;
  isp: string | null;
  asn: string | null;
  /** true when the operator corrected the detected location by hand */
  edited: boolean;
  /** how it was found, e.g. "vercel+lookup", "lookup", "none" */
  via: string;
  detectedAt: string;
}

export interface SpeedRegionResult {
  serverCode: string;
  name: string;
  country: string;
  /** destination details, saved so old sessions still read "from ... to ..." */
  location?: string;
  provider?: string;
  status: 'completed' | 'failed' | 'waiting';
  downloadMbps: number | null;
  uploadMbps: number | null;
  pingMs: number | null;
  jitterMs: number | null;
  errorMessage?: string | null;
}

export interface SpeedSessionSummary {
  totalRegions: number;
  completedRegions: number;
  failedRegions: number;
  avgDownloadMbps: number;
  avgUploadMbps: number;
  avgPingMs: number;
  peakDownloadMbps: number;
}

export interface SpeedTestSession {
  id: string;
  startedAt: string;
  completedAt?: string;
  /** where the test was run from. Missing on sessions saved before this feature existed. */
  source?: SpeedSource | null;
  regions: Record<string, SpeedRegionResult>;
  summary: SpeedSessionSummary;
}
