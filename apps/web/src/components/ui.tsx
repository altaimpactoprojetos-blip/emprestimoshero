import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// ---------- Toasts ----------
interface Toast { id: number; message: string; kind: 'info' | 'error' | 'success' }
const ToastCtx = createContext<{ push: (m: string, k?: Toast['kind']) => void }>({ push: () => {} });
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, message, kind }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">{items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx).push;

// ---------- Básicos ----------
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function StatusBadge({ map, value }: { map: Record<string, { label: string; tone: string }>; value: string }) {
  const m = map[value] ?? { label: value, tone: 'neutral' };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Loading({ text = 'Carregando...' }: { text?: string }) {
  return <div className="loading"><span className="spinner" />{text}</div>;
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{text && <div>{text}</div>}{action && <div className="mt">{action}</div>}</div>;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Não foi possível carregar os dados';
  return <div className="alert error">{msg} {retry && <button className="btn sm" onClick={retry} style={{ marginLeft: 8 }}>Tentar novamente</button>}</div>;
}

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-header"><h2>{title}</h2><button className="modal-close" onClick={onClose} aria-label="Fechar">×</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Confirm({ title, text, onConfirm, onCancel, danger, confirmLabel = 'Confirmar', busy }: { title: string; text: ReactNode; onConfirm: () => void; onCancel: () => void; danger?: boolean; confirmLabel?: string; busy?: boolean }) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="mb">{text}</div>
      <div className="form-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>{busy ? 'Aguarde...' : confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function Field({ label, help, error, children }: { label: string; help?: string; error?: string; children: ReactNode }) {
  return <div className="field"><label>{label}</label>{children}{help && <span className="help">{help}</span>}{error && <span className="error">{error}</span>}</div>;
}

export function KV({ items }: { items: Array<[string, ReactNode]> }) {
  return <dl className="kv">{items.map(([k, v]) => <FragmentKV key={k} k={k} v={v} />)}</dl>;
}
const FragmentKV = ({ k, v }: { k: string; v: ReactNode }) => <><dt>{k}</dt><dd>{v ?? '—'}</dd></>;

export function Tabs({ tabs, value, onChange }: { tabs: Array<{ key: string; label: string }>; value: string; onChange: (k: string) => void }) {
  return <div className="tabs">{tabs.map((t) => <button key={t.key} className={value === t.key ? 'active' : ''} onClick={() => onChange(t.key)}>{t.label}</button>)}</div>;
}

// ---------- Tabela com busca, ordenação, filtros e cartões no celular ----------
export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null | undefined;
  num?: boolean;
  hideOnCard?: boolean;
}

export function DataTable<T extends { id: string }>({ rows, columns, searchKeys, onRowClick, emptyTitle = 'Nenhum registro', emptyText, pageSize = 25, filters, cardTitle, initialSort, footer }: {
  rows: T[];
  columns: Column<T>[];
  searchKeys?: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyText?: string;
  pageSize?: number;
  filters?: ReactNode;
  cardTitle?: (row: T) => ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  footer?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let r = rows;
    if (q && searchKeys) {
      const n = q.toLowerCase();
      r = r.filter((row) => searchKeys(row).toLowerCase().includes(n));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sortValue) {
        const sv = col.sortValue;
        r = [...r].sort((a, b) => {
          const va = sv(a) ?? '', vb = sv(b) ?? '';
          const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'pt-BR');
          return sort.dir === 'asc' ? c : -c;
        });
      }
    }
    return r;
  }, [rows, q, sort, columns, searchKeys]);

  useEffect(() => setPage(1), [q, rows.length]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const slice = filtered.slice((page - 1) * pageSize, page * pageSize);

  const toggleSort = (c: Column<T>) => {
    if (!c.sortValue) return;
    setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' }));
  };

  return (
    <div>
      {(searchKeys || filters) && (
        <div className="toolbar">
          {searchKeys && <input className="input" placeholder="Buscar..." value={q} onChange={(e) => setQ(e.target.value)} />}
          {filters}
        </div>
      )}
      {filtered.length === 0 ? <EmptyState title={emptyTitle} text={emptyText} /> : (
        <>
          <div className="table-wrap">
            <table className="table responsive">
              <thead><tr>{columns.map((c) => <th key={c.key} className={`${c.num ? 'num' : ''} ${c.sortValue ? 'sortable' : ''}`} onClick={() => toggleSort(c)}>{c.label}{sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>)}</tr></thead>
              <tbody>
                {slice.map((row) => (
                  <tr key={row.id} className={onRowClick ? 'row-link' : ''} onClick={() => onRowClick?.(row)}>
                    {columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}</td>)}
                  </tr>
                ))}
              </tbody>
              {footer}
            </table>
          </div>
          <div className="table-cards">
            {slice.map((row) => (
              <div key={row.id} className="tcard" onClick={() => onRowClick?.(row)}>
                {cardTitle && <div style={{ fontWeight: 600, marginBottom: 6 }}>{cardTitle(row)}</div>}
                {columns.filter((c) => !c.hideOnCard).map((c) => <div key={c.key} className="trow"><span>{c.label}</span><span>{c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}</span></div>)}
              </div>
            ))}
          </div>
          <div className="pagination">
            <span>{filtered.length} registro(s)</span>
            {pages > 1 && <span className="flex"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button> Página {page} de {pages} <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button></span>}
          </div>
        </>
      )}
    </div>
  );
}

export function useForm<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const set = (k: keyof T, v: unknown) => setValues((s) => ({ ...s, [k]: v }));
  const bind = (k: keyof T) => ({ value: (values[k] as string | number | undefined) ?? '', onChange: (e: { target: { value: string } }) => set(k, e.target.value) });
  const bindCheck = (k: keyof T) => ({ checked: Boolean(values[k]), onChange: (e: { target: { checked: boolean } }) => set(k, e.target.checked) });
  return { values, set, bind, bindCheck, reset: () => setValues(initial), setValues };
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'details' in e && Array.isArray((e as { details: unknown }).details)) {
    const d = (e as { details: Array<{ path: string; message: string }>; message: string });
    return `${d.message}: ${d.details.map((x) => `${x.path} ${x.message}`).join('; ')}`;
  }
  return e instanceof Error ? e.message : 'Ocorreu um erro';
}
