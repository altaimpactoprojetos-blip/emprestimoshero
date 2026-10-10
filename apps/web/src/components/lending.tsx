import { useEffect, useState, type ReactNode } from 'react';
import { LOAN_DISPLAY } from '../lib/labels';

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return <span className={`st-pill st-${status}`}>{label ?? LOAN_DISPLAY[status] ?? status}</span>;
}

export function Progress({ value, status, labels }: { value: number; status?: string; labels?: [ReactNode, ReactNode] }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={status ? `st-${status}` : ''}>
      <div className="progress" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${v}%` }} /></div>
      {labels && <div className="progress-label"><span>{labels[0]}</span><span>{labels[1]}</span></div>}
    </div>
  );
}

export function BigCard({ label, value, hint, tone, onClick }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'primary' | 'danger' | 'success'; onClick?: () => void }) {
  return (
    <div className={`big-card ${tone ?? ''}`} onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined} role={onClick ? 'button' : undefined}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** Debounce simples para prévias de cálculo enquanto o usuário digita. */
export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
