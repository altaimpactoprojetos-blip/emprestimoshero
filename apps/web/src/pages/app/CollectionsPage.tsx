import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { dateBR, dateTimeBR } from '../../lib/format';
import { REMINDER_STATUS, CHANNEL } from '../../lib/labels';
import { PageHeader, Loading, ErrorState, DataTable, Field, StatusBadge, useToast, errorMessage, Tabs, Stat, Alert, Modal, Badge } from '../../components/ui';

interface Settings { enabled: boolean; timezone: string; sendHourStart: number; sendHourEnd: number; sendDays: number[]; maxPerClientPerDay: number; steps: Array<{ offsetDays: number; channels: string[] }>; channels: { email: string; sms: string } }
interface Reminder { id: string; channel: string; offsetDays: number; status: string; scheduledFor: string; sentAt: string | null; attempts: number; lastError: string | null; cancelReason: string | null; renderedSubject: string | null; renderedBody: string | null; manual: boolean; client: { id: string; name: string }; installment: { number: number; dueDate: string; loanId: string; loan: { number: number } }; attemptsLog: Array<{ number: number; status: string; response: string | null; createdAt: string }> }
interface MsgTemplate { id: string; key: string; channel: string; subject: string | null; body: string }
interface Issue { id: string; kind: string; reference: string | null; message: string; createdAt: string; resolvedAt: string | null }

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const KEY_LABEL: Record<string, string> = { BEFORE_DUE: 'Antes do vencimento', DUE_TODAY: 'No dia do vencimento', OVERDUE: 'Após o vencimento (atraso)' };
const stepLabel = (o: number) => (o < 0 ? `${-o} dia(s) antes do vencimento` : o === 0 ? 'No dia do vencimento' : `${o} dia(s) após o vencimento`);

export function CollectionsPage() {
  const [tab, setTab] = useState('fila');
  const q = useQuery({ queryKey: ['collections', 'summary'], queryFn: () => api<{ scheduled: number; sent24h: number; failed: number; issues: number }>('collections/summary') });
  return (
    <>
      <PageHeader title="Central de cobranças" subtitle="Lembretes automáticos por e-mail, SMS e avisos no portal, processados no servidor mesmo com o navegador fechado. WhatsApp não é utilizado." />
      {q.data && (
        <div className="grid cols-4 mb">
          <Stat label="Agendados" value={q.data.scheduled} />
          <Stat label="Enviados (24h)" value={q.data.sent24h} tone="success" />
          <Stat label="Falhas" value={q.data.failed} tone={q.data.failed ? 'danger' : ''} />
          <Stat label="Pendências de integração" value={q.data.issues} tone={q.data.issues ? 'warning' : ''} />
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'fila', label: 'Fila e histórico' }, { key: 'config', label: 'Sequência e horários' }, { key: 'mensagens', label: 'Mensagens' }, { key: 'pendencias', label: 'Pendências' }]} />
      {tab === 'fila' && <RemindersTab />}
      {tab === 'config' && <SettingsTab />}
      {tab === 'mensagens' && <TemplatesTab />}
      {tab === 'pendencias' && <IssuesTab />}
    </>
  );
}

function RemindersTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [view, setView] = useState<Reminder | null>(null);
  const q = useQuery({ queryKey: ['reminders', status, channel], queryFn: () => api<Reminder[]>(`collections/reminders?status=${status}&channel=${channel}`) });
  const run = useMutation({ mutationFn: () => api<{ scheduled: { created: number }; dispatched: Record<string, number> }>('collections/run', { method: 'POST', body: {} }), onSuccess: (r) => { toast(`Ciclo executado: ${r.scheduled.created} agendado(s), ${Object.entries(r.dispatched).map(([k, v]) => `${v} ${k}`).join(', ') || 'nenhum disparo'}`, 'success'); qc.invalidateQueries({ queryKey: ['reminders'] }); qc.invalidateQueries({ queryKey: ['collections'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  const cancel = useMutation({ mutationFn: (id: string) => api(`collections/reminders/${id}/cancel`, { method: 'POST', body: {} }), onSuccess: () => { toast('Lembrete cancelado', 'success'); qc.invalidateQueries({ queryKey: ['reminders'] }); } });
  return (
    <div className="card">
      <div className="card-header"><h3>Lembretes</h3><button className="btn" onClick={() => run.mutate()} disabled={run.isPending}>Executar ciclo agora</button></div>
      <p className="small muted">O worker executa o ciclo automaticamente a cada 5 minutos. Antes de cada envio a situação da parcela é reavaliada; parcelas quitadas têm os lembretes cancelados e cobranças pausadas são ignoradas.</p>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : (
        <DataTable rows={q.data!} searchKeys={(r) => `${r.client.name} ${r.installment.loan.number}`} onRowClick={setView} cardTitle={(r) => `${r.client.name} · ${CHANNEL[r.channel]}`}
          filters={<><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todas as situações</option>{Object.entries(REMINDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select><select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">Todos os canais</option>{Object.entries(CHANNEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></>}
          emptyTitle="Nenhum lembrete" emptyText="Ative a automação em “Sequência e horários” ou execute o ciclo."
          columns={[
            { key: 'scheduledFor', label: 'Agendado para', render: (r) => dateTimeBR(r.scheduledFor), sortValue: (r) => r.scheduledFor },
            { key: 'client', label: 'Cliente', render: (r) => <><strong>{r.client.name}</strong><div className="small muted">Contrato nº {r.installment.loan.number} · parcela {r.installment.number} ({dateBR(r.installment.dueDate)})</div></>, sortValue: (r) => r.client.name },
            { key: 'step', label: 'Etapa', render: (r) => (r.manual ? 'Envio manual' : stepLabel(r.offsetDays)) },
            { key: 'channel', label: 'Canal', render: (r) => CHANNEL[r.channel] },
            { key: 'status', label: 'Situação', render: (r) => <><StatusBadge map={REMINDER_STATUS} value={r.status} />{(r.lastError || r.cancelReason) && <div className="small muted">{r.lastError ?? r.cancelReason}</div>}</> },
            { key: 'sentAt', label: 'Enviado em', render: (r) => dateTimeBR(r.sentAt) },
            { key: 'act', label: '', render: (r) => <span className="flex"><button className="btn sm" onClick={(e) => { e.stopPropagation(); nav(`/app/emprestimos/${r.installment.loanId}`); }}>Contrato</button>{r.status === 'SCHEDULED' && <button className="btn sm" onClick={(e) => { e.stopPropagation(); cancel.mutate(r.id); }}>Cancelar</button>}</span> },
          ]} />
      )}
      {view && (
        <Modal title={`Lembrete — ${view.client.name}`} onClose={() => setView(null)}>
          <p><strong>{CHANNEL[view.channel]}</strong> · {stepLabel(view.offsetDays)} · <StatusBadge map={REMINDER_STATUS} value={view.status} /></p>
          {view.renderedSubject && <p><strong>Assunto:</strong> {view.renderedSubject}</p>}
          <pre className="code">{view.renderedBody ?? '(mensagem será gerada no momento do envio, com o saldo atualizado)'}</pre>
          <h3>Tentativas</h3>
          {view.attemptsLog.length === 0 ? <p className="muted">Nenhuma tentativa ainda.</p> : <table className="table"><tbody>{view.attemptsLog.map((a) => <tr key={a.number}><td>#{a.number}</td><td>{dateTimeBR(a.createdAt)}</td><td><Badge tone={a.status === 'SENT' ? 'success' : 'danger'}>{a.status === 'SENT' ? 'Enviado' : 'Falhou'}</Badge></td><td className="small mono">{a.response}</td></tr>)}</tbody></table>}
        </Modal>
      )}
    </div>
  );
}

function SettingsTab() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['collections', 'settings'], queryFn: () => api<Settings>('collections/settings') });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { if (q.data) setS(q.data); }, [q.data]);
  const save = useMutation({ mutationFn: () => api('collections/settings', { method: 'PUT', body: { enabled: s!.enabled, timezone: s!.timezone, sendHourStart: Number(s!.sendHourStart), sendHourEnd: Number(s!.sendHourEnd), sendDays: s!.sendDays, maxPerClientPerDay: Number(s!.maxPerClientPerDay), steps: s!.steps.map((st) => ({ offsetDays: Number(st.offsetDays), channels: st.channels })) } }), onSuccess: () => { toast('Configuração salva', 'success'); q.refetch(); }, onError: (e) => toast(errorMessage(e), 'error') });
  if (q.isLoading || !s) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const setStep = (i: number, patch: Partial<{ offsetDays: number; channels: string[] }>) => setS({ ...s, steps: s.steps.map((st, j) => (j === i ? { ...st, ...patch } : st)) });
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Automação</h3>
        <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Cobranças automáticas ativas</label>
        <div className="form-row cols-3">
          <Field label="Fuso horário"><select value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>{['America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Cuiaba', 'America/Campo_Grande', 'America/Noronha'].map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Enviar a partir de (hora)"><input type="number" min="0" max="23" value={s.sendHourStart} onChange={(e) => setS({ ...s, sendHourStart: Number(e.target.value) })} /></Field>
          <Field label="Enviar até (hora)"><input type="number" min="1" max="24" value={s.sendHourEnd} onChange={(e) => setS({ ...s, sendHourEnd: Number(e.target.value) })} /></Field>
        </div>
        <Field label="Dias de envio"><div className="flex">{DAYS.map((d, i) => <label key={i} className="check"><input type="checkbox" checked={s.sendDays.includes(i)} onChange={(e) => setS({ ...s, sendDays: e.target.checked ? [...s.sendDays, i].sort() : s.sendDays.filter((x) => x !== i) })} /> {d}</label>)}</div></Field>
        <Field label="Limite de mensagens (e-mail + SMS) por cliente por dia" help="Considera todos os contratos do cliente. Mensagens excedentes são adiadas para o dia seguinte."><input type="number" min="1" max="20" value={s.maxPerClientPerDay} onChange={(e) => setS({ ...s, maxPerClientPerDay: Number(e.target.value) })} /></Field>
        <Alert kind="info">Canais: e-mail {s.channels.email === 'smtp' ? 'conectado (SMTP)' : 'em modo de demonstração (registrado no histórico, sem envio real)'}; SMS {s.channels.sms !== 'console' ? 'conectado' : 'em modo de demonstração'}.</Alert>
      </div>
      <div className="card">
        <h3>Sequência de lembretes</h3>
        <p className="small muted">Dias negativos = antes do vencimento; 0 = no vencimento; positivos = dias de atraso. Cada etapa pode usar mais de um canal.</p>
        <table className="table"><thead><tr><th>Quando</th><th>Canais</th><th></th></tr></thead><tbody>
          {s.steps.map((st, i) => (
            <tr key={i}>
              <td><input className="input" type="number" style={{ width: 90 }} value={st.offsetDays} onChange={(e) => setStep(i, { offsetDays: Number(e.target.value) })} /> <span className="small muted">{stepLabel(st.offsetDays)}</span></td>
              <td>{Object.entries(CHANNEL).map(([k, v]) => <label key={k} className="check" style={{ display: 'inline-flex', marginRight: 8 }}><input type="checkbox" checked={st.channels.includes(k)} onChange={(e) => setStep(i, { channels: e.target.checked ? [...st.channels, k] : st.channels.filter((c) => c !== k) })} /> {v}</label>)}</td>
              <td><button className="btn sm" onClick={() => setS({ ...s, steps: s.steps.filter((_, j) => j !== i) })}>Remover</button></td>
            </tr>
          ))}
        </tbody></table>
        <div className="form-actions"><button className="btn" onClick={() => setS({ ...s, steps: [...s.steps, { offsetDays: 15, channels: ['EMAIL'] }] })}>Adicionar etapa</button><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Salvar</button></div>
      </div>
    </div>
  );
}

function TemplatesTab() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['collections', 'templates'], queryFn: () => api<{ templates: MsgTemplate[]; variables: string[] }>('collections/templates') });
  const [editing, setEditing] = useState<MsgTemplate | null>(null);
  const save = useMutation({ mutationFn: () => api(`collections/templates/${editing!.id}`, { method: 'PUT', body: { subject: editing!.subject, body: editing!.body } }), onSuccess: () => { toast('Mensagem salva', 'success'); setEditing(null); q.refetch(); }, onError: (e) => toast(errorMessage(e), 'error') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  return (
    <div className="card">
      <h3>Modelos de mensagem</h3>
      <p className="small muted">Variáveis: {q.data!.variables.map((v) => <span key={v} className="mono" style={{ marginRight: 6 }}>{`{{${v}}}`}</span>)}. Use linguagem respeitosa; as mensagens são individuais e o link leva a uma área protegida, sem expor a dívida a terceiros.</p>
      <div className="table-wrap"><table className="table"><thead><tr><th>Etapa</th><th>Canal</th><th>Assunto</th><th>Mensagem</th><th></th></tr></thead><tbody>
        {q.data!.templates.map((t) => <tr key={t.id}><td>{KEY_LABEL[t.key] ?? t.key}</td><td>{CHANNEL[t.channel]}</td><td>{t.subject ?? '—'}</td><td className="small" style={{ whiteSpace: 'pre-wrap', maxWidth: 480 }}>{t.body}</td><td><button className="btn sm" onClick={() => setEditing(t)}>Editar</button></td></tr>)}
      </tbody></table></div>
      {editing && (
        <Modal title={`${KEY_LABEL[editing.key]} — ${CHANNEL[editing.channel]}`} onClose={() => setEditing(null)}>
          {editing.channel !== 'SMS' && <Field label="Assunto / título"><input value={editing.subject ?? ''} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} /></Field>}
          <Field label="Mensagem" help={editing.channel === 'SMS' ? `${editing.body.length}/320 caracteres` : undefined}><textarea style={{ minHeight: 180 }} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></Field>
          <div className="form-actions"><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Salvar</button></div>
        </Modal>
      )}
    </div>
  );
}

export function IssuesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['collections', 'issues'], queryFn: () => api<Issue[]>('collections/issues') });
  const resolve = useMutation({ mutationFn: (id: string) => api(`collections/issues/${id}/resolve`, { method: 'POST', body: {} }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['collections'] }); } });
  const KIND: Record<string, string> = { PAYMENT_WEBHOOK: 'Pagamento (webhook)', CHARGE_CREATE: 'Emissão de cobrança', SIGNATURE: 'Assinatura eletrônica', EMAIL: 'E-mail', SMS: 'SMS' };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  return (
    <div className="card">
      <h3>Pendências de integração</h3>
      <p className="small muted">Falhas de envio, divergências de valores e eventos não reconhecidos ficam aqui para o financeiro resolver.</p>
      <DataTable rows={q.data!} emptyTitle="Nenhuma pendência em aberto" cardTitle={(i) => KIND[i.kind] ?? i.kind} columns={[
        { key: 'createdAt', label: 'Data', render: (i) => dateTimeBR(i.createdAt) }, { key: 'kind', label: 'Tipo', render: (i) => KIND[i.kind] ?? i.kind }, { key: 'message', label: 'Descrição', render: (i) => <span style={{ whiteSpace: 'pre-wrap' }}>{i.message}</span> }, { key: 'ref', label: 'Referência', render: (i) => <span className="mono small">{i.reference}</span> },
        { key: 'act', label: '', render: (i) => <button className="btn sm" onClick={() => resolve.mutate(i.id)}>Marcar como resolvida</button> },
      ]} />
    </div>
  );
}
