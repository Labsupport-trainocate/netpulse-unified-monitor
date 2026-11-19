import React from 'react';

const quality = (value: number, goodMax: number, warnMax: number, lowerBetter = false) => {
  if (lowerBetter) return value <= goodMax ? '#34d399' : value <= warnMax ? '#fbbf24' : '#fb7185';
  return value >= goodMax ? '#34d399' : value >= warnMax ? '#fbbf24' : '#fb7185';
};

export const MetricBar: React.FC<{ label: string; value: number | null | undefined; unit: string; max: number; lowerBetter?: boolean; goodMax?: number; warnMax?: number }> = ({ label, value, unit, max, lowerBetter = false, goodMax = 0.75, warnMax = 0.4 }) => {
  const valid = typeof value === 'number' && Number.isFinite(value);
  const color = valid ? quality(value, lowerBetter ? goodMax : max * goodMax, lowerBetter ? warnMax : max * warnMax, lowerBetter) : '#64748b';
  const width = valid ? Math.max(2, Math.min(100, (lowerBetter ? 1 - value / max : value / max) * 100)) : 0;
  return <div className="min-w-0"><div className="flex justify-between gap-2 text-[11px] mb-1"><span className="text-slate-300">{label}</span><strong className="text-white font-mono">{valid ? `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}` : '—'}</strong></div><div className="h-2 rounded-full bg-slate-800 overflow-hidden"><div className="h-full rounded-full transition-all" style={{ width: `${width}%`, background: color }} /></div></div>;
};

export const MetricVisualGrid: React.FC<{ items: Array<{ label: string; value: number | null | undefined; unit: string; max: number; lowerBetter?: boolean; goodMax?: number; warnMax?: number }> }> = ({ items }) => (
  <div className="mt-4 rounded-xl border border-slate-700/70 bg-[#0c1424]/70 p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
    {items.map(item => <MetricBar key={item.label} {...item} />)}
  </div>
);
