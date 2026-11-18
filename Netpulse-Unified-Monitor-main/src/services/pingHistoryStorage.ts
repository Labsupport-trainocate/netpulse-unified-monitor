/**
 * Session history storage for Ping Monitoring
 *
 * Sessions are kept in this browser's localStorage (instant, works offline) and, when the deployment has a
 * server-side session store (/api/sessions/ping), copied there as well. There is no account system: history
 * saved in one browser is not visible from another browser or device.
 *
 * Deleting a session (or clearing the history) removes it from the server store (if any) and this browser.
 * If the server refuses, the functions below throw an error instead of pretending it worked, because the
 * sessions that remain would come back after a refresh.
 *
 * Designed to be 100% free with minimal storage footprint.
 */

import { type PingSession, type RegionId, type RegionPingResult } from '../types/ping';
import { reportSessionToMonitoring } from './monitoringApi';

const STORAGE_KEY = 'noc_ping_sessions_history_v1';
const SERVER_URL = '/api/sessions/ping';
const MAX_STORED_SESSIONS = 100;
const MAX_DETAILED_PACKETS_SESSIONS = 15;

/**
 * Writes that are still in flight (server). Clearing waits for them, so a session that was
 * saved a moment before "Clear All" cannot arrive afterwards and reappear.
 */
const pendingWrites = new Set<Promise<unknown>>();
function trackWrite<T>(p: Promise<T>): Promise<T> {
  pendingWrites.add(p);
  const done = () => {
    pendingWrites.delete(p);
  };
  p.then(done, done);
  return p;
}
async function waitForPendingWrites(): Promise<void> {
  if (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }
}

/**
 * Strips verbose packet arrays from older sessions to keep storage ultra-lightweight and free
 */
function compactSession(session: PingSession, retainFullPackets: boolean): PingSession {
  if (retainFullPackets) {
    return session;
  }

  const compactedRegions: Record<RegionId, RegionPingResult> = { ...session.regions };
  for (const [rid, res] of Object.entries(session.regions || {})) {
    compactedRegions[rid as RegionId] = {
      ...res,
      packets: [], // Compact verbose per-packet timestamps for older sessions
    };
  }

  return {
    ...session,
    regions: compactedRegions,
  };
}

/**
 * Synchronous local storage read for instantaneous component mounting
 */
export function loadStoredPingSessions(): PingSession[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((s) => s && typeof s === 'object' && s.id && s.startedAt)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  } catch (err) {
    console.warn('Failed to parse stored ping sessions from localStorage:', err);
    return [];
  }
}

/**
 * Save to localStorage cache
 */
function saveToLocalStorage(sessions: PingSession[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const trimmed = sessions.slice(0, MAX_STORED_SESSIONS).map((sess, idx) => {
      return compactSession(sess, idx < MAX_DETAILED_PACKETS_SESSIONS);
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('Failed to save sessions to localStorage:', err);
  }
}

/**
 * Merge two lists of sessions by ID, newest first
 */
function mergeSessions(primary: PingSession[], secondary: PingSession[]): PingSession[] {
  const map = new Map<string, PingSession>();
  for (const s of [...primary, ...secondary]) {
    if (s && s.id && s.startedAt) {
      if (!map.has(s.id)) {
        map.set(s.id, s);
      }
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

/**
 * Fetch sessions from the server API (/api/sessions/ping)
 * Guarantees that any device/tab opening the link gets all past sessions.
 */
export async function fetchServerPingSessions(): Promise<PingSession[]> {
  try {
    const res = await fetch(SERVER_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data && Array.isArray(data.sessions)) {
      return data.sessions;
    }
  } catch (err) {
    // Non-fatal, will fall back to localStorage
    console.warn('[SessionStorage] Server fetch skipped or offline:', err);
  }
  return [];
}

/**
 * Robust fetch combining the server store and LocalStorage:
 * - Loads remote data
 * - Merges with local cache
 * - Saves back to local cache
 */
export async function loadAllPingSessions(): Promise<PingSession[]> {
  const local = loadStoredPingSessions();

  const serverSessions = await fetchServerPingSessions();
  const merged = mergeSessions(serverSessions, local);

  if (merged.length > 0) {
    saveToLocalStorage(merged);
  }

  return merged;
}

/**
 * Persist a newly completed session in LocalStorage and (if available) the server API
 */
export async function persistPingSession(newSession: PingSession): Promise<PingSession[]> {
  // 1. Local update
  const currentLocal = loadStoredPingSessions();
  const updatedLocal = mergeSessions([newSession], currentLocal);
  saveToLocalStorage(updatedLocal);

  // Long-term history + anomaly detection (server side). Never blocks or breaks the test.
  void reportSessionToMonitoring('ping', newSession);

  // 2. Server API update (non-blocking, but tracked so that "Clear All" waits for it)
  trackWrite(
    fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: newSession }),
    }).catch((err) => {
      console.warn('[SessionStorage] Failed to push session to server API:', err);
    })
  );


  return updatedLocal;
}

/* ------------------------------------------------------------------ */
/* Deleting                                                             */
/* ------------------------------------------------------------------ */

/** Server delete. "No such route" (404/405) means this deployment has no server store, which is fine. */
async function deleteOnServer(url: string): Promise<void> {
  try {
    const res = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(8000) });
    if (res.ok || res.status === 404 || res.status === 405) return;
    throw new Error(`the server answered HTTP ${res.status}`);
  } catch (err: any) {
    // Server unreachable: nothing could have been loaded from it either, so it is not a reason to fail.
    if (err instanceof TypeError || err?.name === 'AbortError' || err?.name === 'TimeoutError') return;
    throw err;
  }
}

/**
 * Delete a session from the server store (if any) and this browser.
 * Throws if it could not be removed everywhere (the caller should then keep showing it).
 */
export async function removePingSession(sessionId: string): Promise<PingSession[]> {
  await waitForPendingWrites();
  const problems: string[] = [];

  try {
    await deleteOnServer(`${SERVER_URL}/${encodeURIComponent(sessionId)}`);
  } catch (err: any) {
    problems.push(`server: ${err?.message || err}`);
  }

  if (problems.length > 0) {
    throw new Error(`The session could not be deleted everywhere (${problems.join('; ')}).`);
  }

  const updated = loadStoredPingSessions().filter((s) => s.id !== sessionId);
  saveToLocalStorage(updated);
  return updated;
}

/**
 * Clear all sessions from the server store (if any) and this browser.
 * Throws if something could not be cleared (the sessions that remain would come back after a refresh).
 */
export async function clearAllPingSessions(): Promise<void> {
  await waitForPendingWrites();
  const problems: string[] = [];

  try {
    await deleteOnServer(SERVER_URL);
  } catch (err: any) {
    problems.push(`server: ${err?.message || err}`);
  }

  if (problems.length > 0) {
    throw new Error(`The session history could not be fully cleared (${problems.join('; ')}).`);
  }

  // Only when everything remote is gone: clear the local cache too.
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
}

export interface FormattedDateTime {
  dateFull: string;        // e.g. "Thu, Oct 29, 2026"
  dateShort: string;       // e.g. "Oct 29, 2026"
  timeWithSeconds: string; // e.g. "02:35:12 PM"
  timeShort: string;       // e.g. "02:35 PM"
  relative: string;        // e.g. "2 mins ago"
  epochMs: number;
}

/**
 * Format ISO string into crisp, highly legible date and time representations
 */
export function formatSessionDateTime(isoString: string): FormattedDateTime {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) {
      throw new Error('Invalid date');
    }

    const dateFull = d.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    const dateShort = d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    const timeWithSeconds = d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    const timeShort = d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

    const now = Date.now();
    const diffSec = Math.floor((now - d.getTime()) / 1000);

    let relative = 'Just now';
    if (diffSec < 45) {
      relative = 'Just now';
    } else if (diffSec < 3600) {
      const mins = Math.floor(diffSec / 60);
      relative = `${mins} min${mins > 1 ? 's' : ''} ago`;
    } else if (diffSec < 86400) {
      const hours = Math.floor(diffSec / 3600);
      relative = `${hours} hr${hours > 1 ? 's' : ''} ago`;
    } else {
      const days = Math.floor(diffSec / 86400);
      relative = `${days} day${days > 1 ? 's' : ''} ago`;
    }

    return {
      dateFull,
      dateShort,
      timeWithSeconds,
      timeShort,
      relative,
      epochMs: d.getTime(),
    };
  } catch {
    return {
      dateFull: isoString,
      dateShort: isoString,
      timeWithSeconds: isoString,
      timeShort: isoString,
      relative: 'Recorded',
      epochMs: 0,
    };
  }
}
