import React from 'react';
import { ArrowDown, ArrowRight, MapPin, Server, Loader2, AlertTriangle, PencilLine } from 'lucide-react';
import type { SourceView } from '../services/clientInfo';

interface RouteStripProps {
  /** where the person who launched the test is (the source) */
  from: SourceView;
  /** the data center that was tested (the destination) */
  toTitle: string;
  toSub?: string;
  /** destination accent colour (the region's own colour) */
  accent?: string;
  compact?: boolean;
}

/**
 * "FROM <where the tester is>  ->  TO <data center>"
 * Shown inside every regional result so each number can be read as a route, not just a value.
 */
export const RouteStrip: React.FC<RouteStripProps> = ({ from, toTitle, toSub, accent = '#22d3ee', compact = false }) => {
  const pad = compact ? 'px-2.5 py-2' : 'px-3 py-2.5';

  return (
    <div className={`rounded-xl border border-slate-700/70 bg-[#0c1424] ${pad}`} data-testid="route-strip">
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-3">
        {/* FROM */}
        <div className="min-w-0">
          <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1">
            <MapPin className="w-3 h-3" /> From · test source
          </div>
          {from.state === 'loading' && (
            <div className="mt-0.5 text-xs text-slate-300 flex items-center gap-1.5" data-testid="route-from">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" /> Detecting your location…
            </div>
          )}
          {from.state === 'unavailable' && (
            <div className="mt-0.5" data-testid="route-from">
              <div className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> Location not available
              </div>
              <div className="text-[11px] text-slate-400 truncate" title={from.reason}>{from.reason}</div>
            </div>
          )}
          {from.state === 'ready' && (
            <div className="mt-0.5 min-w-0" data-testid="route-from">
              <div className="text-sm font-bold text-white leading-tight break-words flex items-center gap-1.5 flex-wrap">
                <span>{from.source.label}</span>
                {from.source.edited && (
                  <span className="inline-flex items-center gap-0.5 text-[9px] font-mono font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-1 py-px">
                    <PencilLine className="w-2.5 h-2.5" /> edited
                  </span>
                )}
              </div>
              {(from.source.isp || from.source.ip) && (
                <div className="text-[11px] text-slate-400 font-mono truncate" title={[from.source.isp, from.source.ip].filter(Boolean).join(' · ')}>
                  {[from.source.isp, from.source.ip].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* arrow */}
        <div className="flex items-center justify-center text-slate-500">
          <ArrowRight className="hidden sm:block w-5 h-5" style={{ color: accent }} />
          <ArrowDown className="sm:hidden w-4 h-4" style={{ color: accent }} />
        </div>

        {/* TO */}
        <div className="min-w-0 sm:text-right">
          <div className="text-[10px] font-mono font-bold uppercase tracking-wider flex items-center gap-1 sm:justify-end" style={{ color: accent }}>
            <Server className="w-3 h-3" /> To · destination
          </div>
          <div className="mt-0.5 text-sm font-bold text-white leading-tight break-words" data-testid="route-to">{toTitle}</div>
          {toSub && <div className="text-[11px] text-slate-400 font-mono truncate" title={toSub}>{toSub}</div>}
        </div>
      </div>
    </div>
  );
};
