import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, downloadFile } from '../../../lib/api';
import { dateBR, todayISO } from '../../../lib/format';
import type { BalanceLoan, Contract, LendingSettings } from '../../../lib/types';
import { useAuth } from '../../../auth/AuthContext';
import { Loading, ErrorState, Field, Alert, Confirm, Tabs, useToast, errorMessage } from '../../../components/ui';
import { StatusPill } from '../../../components/lending';
import { sharePdf } from '../../../lib/share';

const contractMessage = (loan: BalanceLoan) => `Olá, ${loan.client.name.split(' ')[0]}! Segue o contrato do empréstimo nº ${loan.number} para conferência e assinatura.`;

export function ContractsTab({ loan, onChange }: { loan: BalanceLoan; onChange: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [del, setDel] = useState<Contract | null>(null);
  const signed = useMutation({ mutationFn: (id: string) => api(`lending/contracts/${id}/signed`, { method: 'POST', body: {} }), onSuccess: () => { toast('Contrato marcado como assinado', 'success'); onChange(); }, onError: (e) => toast(errorMessage(e), 'error') });
  const remove = useMutation({ mutationFn: (id: string) => api(`lending/contracts/${id}`, { method: 'DELETE' }), onSuccess: () => { toast('Contrato excluído', 'success'); setDel(null); onChange(); }, onError: (e) => toast(errorMessage(e), 'error') });
  const share = async (c: Contract) => {
    if (!c.file) return;
    try { if ((await sharePdf(`/api/company/files/${c.file.id}`, c.file.filename, contractMessage(loan), loan.client.phone)) === 'fallback') toast('PDF baixado. Anexe o arquivo na conversa do WhatsApp.', 'info'); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  return (
    <>
      {can('contracts.manage') && <button className="btn primary mb" onClick={() => nav(`/app/emprestimos/${loan.id}/contrato`)}>Gerar contrato</button>}
      {loan.contracts.length === 0 ? <p className="muted">Nenhum contrato gerado ainda.</p> : (
        <div className="list">
          {loan.contracts.map((c) => (
            <div key={c.id} className="list-item" style={{ alignItems: 'flex-start' }}>
              <div className="main-col">
                <div className="title">Contrato versão {c.version} {c.status === 'SIGNED' ? <StatusPill status="ON_TIME" label="Assinado" /> : <StatusPill status="PAID" label="Gerado" />}</div>
                <div className="meta">Gerado em {dateBR(c.createdAt)}{c.signedAt ? ` · assinado em ${dateBR(c.signedAt)}` : ''}</div>
                <div className="flex" style={{ marginTop: 6 }}>
                  {c.file && <button className="btn sm" onClick={() => downloadFile(`/api/company/files/${c.file!.id}?download=1`, c.file!.filename)}>Baixar PDF</button>}
                  {c.file && <button className="btn sm success" onClick={() => share(c)}>WhatsApp</button>}
                  {can('contracts.manage') && c.status !== 'SIGNED' && <button className="btn sm" onClick={() => signed.mutate(c.id)}>Marcar como assinado</button>}
                  {can('contracts.manage') && <button className="btn sm" style={{ color: 'var(--danger)' }} onClick={() => setDel(c)}>Excluir</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {del && <Confirm danger title="Excluir contrato" confirmLabel="Excluir" busy={remove.isPending} text={`Excluir a versão ${del.version} do contrato? O PDF deixará de aparecer no histórico.`} onCancel={() => setDel(null)} onConfirm={() => remove.mutate(del.id)} />}
    </>
  );
}

interface Draft { text: string; missing: string[] }

/** Gerar contrato: opções → texto preenchido (editável) → pré-visualização → PDF, WhatsApp e histórico. */
export function ContractPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const loan = useQuery({ queryKey: ['balance-loan', id], queryFn: () => api<BalanceLoan>(`lending/loans/${id}`) });
  const settings = useQuery({ queryKey: ['lending-settings'], queryFn: () => api<{ lending: LendingSettings; creditor: { pixKey?: string } }>('lending/settings') });
  const [opts, setOpts] = useState({ disbursementMethod: '', paymentMethod: '', guarantee: '', witness1: '', witness2: '', accelerationDays: '', quitationDays: '', forum: '', city: '', date: todayISO() });
  const [text, setText] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const [view, setView] = useState('editar');
  const [saved, setSaved] = useState<Contract | null>(null);
  const set = (k: keyof typeof opts, v: string) => setOpts((s) => ({ ...s, [k]: v }));
  useEffect(() => {
    if (loan.data && settings.data) setOpts((s) => ({ ...s, disbursementMethod: s.disbursementMethod || loan.data.disbursementMethod || '', paymentMethod: s.paymentMethod || (settings.data.creditor.pixKey ? `PIX para a chave ${settings.data.creditor.pixKey}` : ''), accelerationDays: s.accelerationDays || String(settings.data.lending.accelerationDays), quitationDays: s.quitationDays || String(settings.data.lending.quitationDays) }));
  }, [loan.data, settings.data]);
  const build = useMutation({
    mutationFn: () => api<Draft>(`lending/loans/${id}/contract/draft`, { body: { ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== '')), accelerationDays: opts.accelerationDays ? Number(opts.accelerationDays) : undefined, quitationDays: opts.quitationDays ? Number(opts.quitationDays) : undefined } }),
    onSuccess: (d) => { setText(d.text); setMissing(d.missing); setView('editar'); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const save = useMutation({
    mutationFn: () => api<Contract>(`lending/loans/${id}/contracts`, { body: { text } }),
    onSuccess: (c) => { setSaved(c); toast('Contrato gerado e guardado no histórico do empréstimo', 'success'); qc.invalidateQueries({ queryKey: ['balance-loan', id] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (loan.isLoading || settings.isLoading) return <Loading />;
  if (loan.error || !loan.data) return <ErrorState error={loan.error} />;
  const l = loan.data;
  const share = async () => {
    if (!saved?.file) return;
    try { if ((await sharePdf(`/api/company/files/${saved.file.id}`, saved.file.filename, contractMessage(l), l.client.phone)) === 'fallback') toast('PDF baixado. Anexe o arquivo na conversa do WhatsApp.', 'info'); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}><div><h1>Gerar contrato</h1><div className="small muted">{l.client.name} · empréstimo nº {l.number}</div></div><button className="btn" onClick={() => nav(`/app/emprestimos/${l.id}`)}>Voltar</button></div>
      {saved ? (
        <div className="card">
          <Alert kind="success">Contrato versão {saved.version} gerado e guardado no histórico do empréstimo.</Alert>
          <div className="flex">
            {saved.file && <button className="btn primary lg" onClick={() => downloadFile(`/api/company/files/${saved.file!.id}?download=1`, saved.file!.filename)}>Baixar PDF</button>}
            <button className="btn success lg" onClick={share}>Compartilhar no WhatsApp</button>
            <button className="btn lg" onClick={() => nav(`/app/emprestimos/${l.id}`)}>Voltar ao empréstimo</button>
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <h3>1. Informações do contrato</h3>
            <p className="small muted">Os dados do credor vêm de Configurações e os do devedor, do cadastro do cliente.</p>
            <div className="form-row">
              <Field label="Dinheiro entregue por"><input value={opts.disbursementMethod} onChange={(e) => set('disbursementMethod', e.target.value)} placeholder="PIX, transferência ou dinheiro" /></Field>
              <Field label="Forma de pagamento"><input value={opts.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)} placeholder="PIX para a chave ..." /></Field>
              <Field label="Testemunha 1 (nome e CPF)"><input value={opts.witness1} onChange={(e) => set('witness1', e.target.value)} /></Field>
              <Field label="Testemunha 2 (nome e CPF)"><input value={opts.witness2} onChange={(e) => set('witness2', e.target.value)} /></Field>
              <Field label="Vencimento antecipado após (dias de atraso)"><input type="number" min="0" value={opts.accelerationDays} onChange={(e) => set('accelerationDays', e.target.value)} /></Field>
              <Field label="Termo de quitação em até (dias)"><input type="number" min="0" value={opts.quitationDays} onChange={(e) => set('quitationDays', e.target.value)} /></Field>
              <Field label="Cidade da assinatura" help="Padrão: cidade do credor"><input value={opts.city} onChange={(e) => set('city', e.target.value)} /></Field>
              <Field label="Data da assinatura"><input type="date" value={opts.date} onChange={(e) => set('date', e.target.value)} /></Field>
              <Field label="Foro (cidade/UF)" help="Padrão definido em Configurações"><input value={opts.forum} onChange={(e) => set('forum', e.target.value)} /></Field>
            </div>
            <Field label="Garantia (opcional)" help="Fiador, nota promissória ou bem dado em garantia"><textarea value={opts.guarantee} onChange={(e) => set('guarantee', e.target.value)} /></Field>
            <button className="btn primary" disabled={build.isPending} onClick={() => build.mutate()}>{build.isPending ? 'Montando...' : text ? 'Montar texto de novo' : 'Montar texto do contrato'}</button>
          </div>
          {text && (
            <div className="card">
              <h3>2. Confira e edite o texto</h3>
              {missing.length > 0 && <Alert kind="warning">Faltam dados (aparecem como [preencher]): {missing.join('; ')}. Complete no cadastro e monte de novo, ou edite direto no texto.</Alert>}
              <Tabs value={view} onChange={setView} tabs={[{ key: 'editar', label: 'Editar texto' }, { key: 'ver', label: 'Pré-visualizar' }]} />
              {view === 'editar' ? <textarea className="contract-editor" value={text} onChange={(e) => setText(e.target.value)} aria-label="Texto do contrato" /> : (
                <div className="doc-preview" style={{ whiteSpace: 'normal' }}>
                  {paragraphs.map((p, i) => (i === 0 ? <h1 key={i}>{p}</h1> : <p key={i} style={{ whiteSpace: 'pre-wrap', textAlign: /_{5,}/.test(p) ? 'left' : 'justify', marginTop: /_{5,}/.test(p) ? 24 : undefined }}>{p}</p>))}
                </div>
              )}
              <div className="form-actions"><button className="btn primary lg" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Gerando PDF...' : 'Gerar contrato em PDF'}</button></div>
              {text.includes('[preencher]') && <p className="small muted right">O texto ainda tem campos “[preencher]”: complete antes de gerar, se possível.</p>}
            </div>
          )}
        </>
      )}
    </>
  );
}
