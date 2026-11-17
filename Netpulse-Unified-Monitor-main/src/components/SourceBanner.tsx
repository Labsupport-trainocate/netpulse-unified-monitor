import React, { useState } from 'react';
import { MapPin, RefreshCw, PencilLine, Check, X, Globe2, Loader2, AlertTriangle } from 'lucide-react';
import type { SourceView } from '../services/clientInfo';

interface SourceBannerProps {
  view: SourceView;
  /** true while a test is running: the label cannot be changed in the middle of a run */
  locked: boolean;
  /** true once a run has finished on this page: a correction then applies to the NEXT test */
  appliesToNext: boolean;
  onSaveLabel: (label: string | null) => void;
  onRedetect: () => void;
}

/** "Test source": where YOU are connecting from. Every regional result below is a route from here to a data center. */
export const SourceBanner: React.FC<SourceBannerProps> = ({ view, locked, appliesToNext, onSaveLabel, onRedetect }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = () => {
    setDraft(view.state === 'ready' ? view.source.label : '');
    setEditing(true);
  };
  const save = () => {
    onSaveLabel(draft.trim() || null);
    setEditing(false);
  };

  return (
    <section className="bg-[#141e33]/90 border border-emerald-500/30 rounded-2xl p-5 sm:p-6 shadow-xl" aria-label="Test source">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 flex items-center justify-center shrink-0">
            <MapPin className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-400">Test source · where this speed test starts</div>

            {view.state === 'loading' && (
              <div className="mt-1 text-base font-bold text-white flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-cyan-400" /> Detecting your location…
              </div>
            )}

            {view.state === 'unavailable' && (
              <div className="mt-1">
                <div className="text-base font-bold text-amber-300 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" /> Location could not be detected
                </div>
                <p className="text-xs text-slate-400 mt-0.5">{view.reason} You can still run the test; use “Set location” so the results show where you are.</p>
              </div>
            )}

            {view.state === 'ready' && !editing && (
              <div className="mt-1 min-w-0">
                <div className="text-lg sm:text-xl font-black text-white tracking-tight break-words flex items-center gap-2 flex-wrap">
                  {view.source.label}
                  {view.source.edited && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">
                      <PencilLine className="w-3 h-3" /> edited by you
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-slate-300">
                  {view.source.isp && <span><span className="text-slate-500">Network </span>{view.source.isp}{view.source.asn ? ` (${view.source.asn})` : ''}</span>}
                  {view.source.ip && <span><span className="text-slate-500">IP </span>{view.source.ip}</span>}
                </div>
              </div>
            )}

            {editing && (
              <div className="mt-2 flex flex-col sm:flex-row gap-2 sm:items-center">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
                  maxLength={80}
                  placeholder="e.g. Bengaluru Office, Karnataka, India"
                  className="w-full sm:w-96 bg-[#0c1424] border border-slate-600 focus:border-cyan-400 outline-none rounded-lg px-3 py-2 text-sm text-white"
                  aria-label="Your location"
                />
                <div className="flex items-center gap-2">
                  <button type="button" onClick={save} className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-bold bg-cyan-600 hover:bg-cyan-500 text-white cursor-pointer">
                    <Check className="w-3.5 h-3.5" /> Save
                  </button>
                  {view.state === 'ready' && view.source.edited && (
                    <button type="button" onClick={() => { onSaveLabel(null); setEditing(false); }} className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 cursor-pointer">
                      Use detected
                    </button>
                  )}
                  <button type="button" onClick={() => setEditing(false)} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer" aria-label="Cancel">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            <p className="mt-2 text-[11px] text-slate-400 leading-relaxed flex items-start gap-1.5 max-w-2xl">
              <Globe2 className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-px" />
              <span>
                Found from your public IP address, so it is approximate (a VPN or office network may show where it connects to the internet).
                {' '}Each result below is the speed from this location to one of our data centers.
                {appliesToNext && ' A change here applies to the next test.'}
              </span>
            </p>
          </div>
        </div>

        {!editing && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={startEdit}
              disabled={locked || view.state === 'loading'}
              title={locked ? 'Not while a test is running' : 'Correct the location shown in the results'}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <PencilLine className="w-3.5 h-3.5" /> {view.state === 'ready' ? 'Edit' : 'Set location'}
            </button>
            <button
              type="button"
              onClick={onRedetect}
              disabled={locked || view.state === 'loading'}
              title="Detect again"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Re-detect
            </button>
          </div>
        )}
      </div>
    </section>
  );
};
