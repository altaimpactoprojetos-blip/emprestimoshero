import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, openFile, downloadFile } from '../../lib/api';
import { brl, dateBR, dateTimeBR, maskDocument } from '../../lib/format';
import { CONTRACT_STATUS } from '../../lib/labels';
import type { Contract, Loan } from '../../lib/types';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, StatusBadge, EmptyState, Modal, Field, useToast, errorMessage, Alert, KV, Loading, ErrorState, PageHeader, Badge, useForm } from '../../components/ui';

interface Template { id: string; name: string; version: number; content: string; status: string; approvedAt: string | null; legalReviewNotes: string | null; updatedAt: string }
interface ContractDetail extends Contract { html: string; loan?: { id: string; number: number; status: string; client: { name: string } }; template: { name: string; version: number } | null; addenda: Contract[]; parentContract: { id: string; version: number } | null; signatureEvidence: Record<string, unknown> | null; signatureSimulationAvailable: boolean }

export function ContractViewer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['contract', id], queryFn: () => api<ContractDetail>(`contracts/${id}`) });
  const [cancelReason, setCancelReason] = useState('');
  const act = useMutation({ mutationFn: (a: string) => api(`contracts/${id}/${a}`, { body: { reason: cancelReason } }), onSuccess: () => { toast('Contrato atualizado', 'success'); q.refetch(); onChanged(); }, onError: (e) => toast(errorMessage(e), 'error') });
  if (q.isLoading) return <Modal title="Contrato" onClose={onClose} wide><Loading /></Modal>;
  if (q.error || !q.data) return <Modal title="Contrato" onClose={onClose} wide><ErrorState error={q.error} /></Modal>;
  const c = q.data;
  return (
    <Modal title={`${c.kind === 'ADDENDUM' ? 'Aditivo' : 'Contrato'} — empréstimo nº ${c.loan?.number} · versão ${c.version}`} onClose={onClose} wide>
      <div className="flex between mb">
        <span className="flex"><StatusBadge map={CONTRACT_STATUS} value={c.status} />{c.template && <span className="small muted">Modelo “{c.template.name}” v{c.templateVersion}</span>}</span>
        <span className="flex">
          <button className="btn sm" onClick={() => openFile(`/api/contracts/${c.id}/pdf`)}>Abrir PDF</button>
          <button className="btn sm" onClick={() => downloadFile(`/api/contracts/${c.id}/pdf?download=1`, `contrato-${c.loan?.number}-v${c.version}.pdf`)}>Baixar</button>
          {can('contracts.manage') && c.status === 'DRAFT' && <button className="btn sm" onClick={() => act.mutate('review')}>Enviar para revisão</button>}
          {can('contracts.manage') && c.status === 'IN_REVIEW' && <button className="btn sm" onClick={() => act.mutate('back_to_draft')}>Voltar a rascunho</button>}
          {can('contracts.manage') && ['DRAFT', 'IN_REVIEW'].includes(c.status) && <button className="btn sm primary" onClick={() => act.mutate('request_signature')}>Enviar para assinatura</button>}
          {can('contracts.manage') && c.status === 'AWAITING_SIGNATURE' && c.signatureSimulationAvailable && <button className="btn sm primary" onClick={() => act.mutate('simulate-signature')}>Simular assinatura (demonstração)</button>}
        </span>
      </div>
      {c.status === 'AWAITING_SIGNATURE' && <Alert kind="warning">Aguardando assinatura pelo provedor {c.signatureProvider} (envelope {c.signatureExternalId}). {c.signatureSimulationAvailable && 'Provedor de demonstração: use “Simular assinatura”.'}</Alert>}
      {c.status === 'SIGNED' && <Alert kind="success">Assinado em {dateTimeBR(c.signedAt)}. Documento preservado; alterações exigem aditivo. Hash SHA-256: <span className="mono">{c.sha256}</span></Alert>}
      {c.status === 'CANCELLED' && <Alert kind="error">Cancelado em {dateTimeBR(c.cancelledAt)}. {c.cancelReason}</Alert>}
      <div className="grid cols-2">
        <div>
          <h3>Signatários</h3>
          <table className="table"><tbody>{c.signers?.map((s) => <tr key={s.id}><td>{s.name}<div className="small muted">{s.role === 'BORROWER' ? 'Devedor(a)' : s.role === 'LENDER' ? 'Credora' : 'Testemunha'} · {s.email ?? '—'}</div></td><td>{s.signedAt ? <Badge tone="success">Assinou em {dateTimeBR(s.signedAt)}</Badge> : <Badge>Pendente</Badge>}</td></tr>)}</tbody></table>
        </div>
        <div>
          <h3>Rastreabilidade</h3>
          <KV items={[['Criado em', dateTimeBR(c.createdAt)], ['Hash SHA-256 do PDF', <span className="mono" style={{ wordBreak: 'break-all' }}>{c.sha256}</span>], ['Provedor', c.signatureProvider ?? '—'], ['Vinculado a', c.parentContract ? `Contrato versão ${c.parentContract.version}` : '—'], ['Aditivos', c.addenda?.length ? c.addenda.map((a) => `v${a.version} (${CONTRACT_STATUS[a.status]?.label})`).join(', ') : 'nenhum']]} />
          {c.signatureEvidence && <details><summary className="small" style={{ cursor: 'pointer' }}>Evidências do provedor</summary><pre className="code">{JSON.stringify(c.signatureEvidence, null, 2)}</pre></details>}
        </div>
      </div>
      {can('contracts.manage') && !['SIGNED', 'CANCELLED'].includes(c.status) && (
        <div className="flex mt"><input className="input" placeholder="Motivo do cancelamento" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} /><button className="btn danger sm" onClick={() => act.mutate('cancel')}>Cancelar contrato</button></div>
      )}
      <h3 className="mt">Pré-visualização</h3>
      <div className="doc-preview" dangerouslySetInnerHTML={{ __html: c.html }} />
    </Modal>
  );
}

export function LoanContractsSection({ loan, onDone }: { loan: Loan; onDone: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const [viewing, setViewing] = useState<string | null>(null);
  const [gen, setGen] = useState<null | { kind: 'CONTRACT' | 'ADDENDUM'; parentContractId?: string }>(null);
  const [templateId, setTemplateId] = useState('');
  const [extraText, setExtraText] = useState('');
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<{ templates: Template[] }>('contracts/templates'), enabled: can('contracts.manage') });
  const approved = templates.data?.templates.filter((t) => t.status === 'APPROVED') ?? [];
  useEffect(() => { if (!templateId && approved[0]) setTemplateId(approved[0].id); }, [approved, templateId]);
  const generate = useMutation({ mutationFn: () => api<Contract>('contracts/generate', { body: { loanId: loan.id, templateId, kind: gen!.kind, parentContractId: gen!.parentContractId, extraText: extraText || undefined } }), onSuccess: (c) => { toast('Documento gerado', 'success'); setGen(null); onDone(); setViewing(c.id); }, onError: (e) => toast(errorMessage(e), 'error') });
  const signed = loan.contracts.find((c) => c.kind === 'CONTRACT' && c.status === 'SIGNED');
  const canGenerate = can('contracts.manage') && !['DRAFT', 'CANCELLED', 'REJECTED'].includes(loan.status);
  return (
    <>
      <div className="flex between mb">
        <span className="muted small">Contratos são gerados a partir de modelos aprovados após revisão jurídica. Após assinado, o documento é preservado e alterações geram aditivo vinculado.</span>
        <span className="flex">
          {canGenerate && !signed && <button className="btn primary sm" onClick={() => setGen({ kind: 'CONTRACT' })}>Emitir contrato</button>}
          {canGenerate && signed && <button className="btn primary sm" onClick={() => setGen({ kind: 'ADDENDUM', parentContractId: signed.id })}>Emitir aditivo</button>}
        </span>
      </div>
      {loan.status === 'DRAFT' && <Alert kind="info">Envie a proposta para avaliação e aprovação antes de emitir o contrato.</Alert>}
      {loan.contracts.length === 0 ? <EmptyState title="Nenhum contrato emitido" /> : (
        <DataTable rows={loan.contracts} onRowClick={(c) => setViewing(c.id)} cardTitle={(c) => `${c.kind === 'ADDENDUM' ? 'Aditivo' : 'Contrato'} v${c.version}`} columns={[
          { key: 'version', label: 'Versão', render: (c) => `${c.kind === 'ADDENDUM' ? 'Aditivo' : 'Contrato'} v${c.version}` },
          { key: 'status', label: 'Situação', render: (c) => <StatusBadge map={CONTRACT_STATUS} value={c.status} /> },
          { key: 'createdAt', label: 'Gerado em', render: (c) => dateTimeBR(c.createdAt) },
          { key: 'signedAt', label: 'Assinado em', render: (c) => dateTimeBR(c.signedAt) },
          { key: 'signers', label: 'Signatários', render: (c) => c.signers?.map((s) => `${s.name}${s.signedAt ? ' ✓' : ''}`).join(', ') },
          { key: 'act', label: '', render: (c) => <button className="btn sm" onClick={(e) => { e.stopPropagation(); openFile(`/api/contracts/${c.id}/pdf`); }}>PDF</button> },
        ]} />
      )}
      {viewing && <ContractViewer id={viewing} onClose={() => setViewing(null)} onChanged={onDone} />}
      {gen && (
        <Modal title={gen.kind === 'ADDENDUM' ? 'Emitir aditivo' : 'Emitir contrato'} onClose={() => setGen(null)}>
          {approved.length === 0 ? <Alert kind="warning">Nenhum modelo aprovado. Aprove um modelo em Configurações › Modelos de contrato.</Alert> : (
            <>
              <Field label="Modelo aprovado"><select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>{approved.map((t) => <option key={t.id} value={t.id}>{t.name} — versão {t.version}</option>)}</select></Field>
              {gen.kind === 'ADDENDUM' && <Field label="Texto do aditivo (cláusulas alteradas)"><textarea value={extraText} onChange={(e) => setExtraText(e.target.value)} /></Field>}
              <p className="small muted">Os dados das partes, condições financeiras, cronograma e regras de atraso serão preenchidos automaticamente com os valores do empréstimo nº {loan.number} ({brl(loan.principalAmount)}, {loan.installmentsCount} parcelas).</p>
              <div className="form-actions"><button className="btn" onClick={() => setGen(null)}>Cancelar</button><button className="btn primary" disabled={generate.isPending || !templateId} onClick={() => generate.mutate()}>{generate.isPending ? 'Gerando PDF...' : 'Gerar'}</button></div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

export function ContractsPage() {
  const [status, setStatus] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['contracts', status], queryFn: () => api<Array<Contract & { loan: { id: string; number: number; principalAmount: string; client: { id: string; name: string; document: string } } }>>(`contracts?status=${status}`) });
  return (
    <>
      <PageHeader title="Contratos" subtitle="Acompanhamento de emissão, revisão, assinatura e aditivos." />
      <div className="card">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : (
          <DataTable rows={q.data!} searchKeys={(c) => `${c.loan.client.name} ${c.loan.client.document} ${c.loan.number}`} onRowClick={(c) => setViewing(c.id)} cardTitle={(c) => `${c.loan.client.name} · nº ${c.loan.number}`}
            filters={<select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option>{Object.entries(CONTRACT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>}
            emptyTitle="Nenhum contrato"
            columns={[
              { key: 'client', label: 'Cliente', render: (c) => <><strong>{c.loan.client.name}</strong><div className="small muted">{maskDocument(c.loan.client.document)}</div></>, sortValue: (c) => c.loan.client.name },
              { key: 'loan', label: 'Empréstimo', render: (c) => `nº ${c.loan.number} · ${brl(c.loan.principalAmount)}` },
              { key: 'kind', label: 'Documento', render: (c) => `${c.kind === 'ADDENDUM' ? 'Aditivo' : 'Contrato'} v${c.version}` },
              { key: 'status', label: 'Situação', render: (c) => <StatusBadge map={CONTRACT_STATUS} value={c.status} />, sortValue: (c) => c.status },
              { key: 'createdAt', label: 'Emitido', render: (c) => dateBR(c.createdAt), sortValue: (c) => c.createdAt },
              { key: 'signedAt', label: 'Assinado', render: (c) => dateBR(c.signedAt) },
            ]} />
        )}
      </div>
      {viewing && <ContractViewer id={viewing} onClose={() => setViewing(null)} onChanged={() => q.refetch()} />}
    </>
  );
}

export function TemplatesSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['templates'], queryFn: () => api<{ templates: Template[]; placeholders: Array<{ key: string; label: string }> }>('contracts/templates') });
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [approveId, setApproveId] = useState<string | null>(null);
  const [legal, setLegal] = useState('');
  const f = useForm({ name: '', content: '', legalReviewNotes: '' });
  const save = useMutation({ mutationFn: () => (editing === 'new' ? api('contracts/templates', { body: f.values }) : api(`contracts/templates/${(editing as Template).id}`, { method: 'PUT', body: f.values })), onSuccess: () => { toast('Modelo salvo', 'success'); setEditing(null); qc.invalidateQueries({ queryKey: ['templates'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  const approve = useMutation({ mutationFn: () => api(`contracts/templates/${approveId}/approve`, { body: { legalReviewNotes: legal } }), onSuccess: () => { toast('Modelo aprovado', 'success'); setApproveId(null); setLegal(''); qc.invalidateQueries({ queryKey: ['templates'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  const archive = useMutation({ mutationFn: (id: string) => api(`contracts/templates/${id}/archive`, { method: 'POST', body: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }) });
  const doPreview = async () => { try { setPreview((await api<{ html: string }>('contracts/templates/preview', { body: { content: f.values.content } })).html); } catch (e) { toast(errorMessage(e), 'error'); } };
  const open = (t: Template | 'new') => { if (t === 'new') f.reset(); else f.setValues({ name: t.name, content: t.content, legalReviewNotes: t.legalReviewNotes ?? '' }); setEditing(t); };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const TS: Record<string, { label: string; tone: string }> = { DRAFT: { label: 'Rascunho', tone: 'neutral' }, APPROVED: { label: 'Aprovado', tone: 'success' }, ARCHIVED: { label: 'Arquivado', tone: 'neutral' } };
  return (
    <div className="card">
      <div className="card-header"><h3>Modelos de contrato</h3><span className="flex"><button className="btn" onClick={() => nav('/app/contratos')}>Ver contratos</button><button className="btn primary" onClick={() => open('new')}>Novo modelo</button></span></div>
      <p className="muted">Modelos são versionados: editar um modelo aprovado cria uma nova versão em rascunho. Apenas versões aprovadas após revisão jurídica geram contratos.</p>
      <DataTable rows={q.data!.templates} onRowClick={open} cardTitle={(t) => `${t.name} v${t.version}`} columns={[
        { key: 'name', label: 'Modelo' }, { key: 'version', label: 'Versão', render: (t) => `v${t.version}` }, { key: 'status', label: 'Situação', render: (t) => <StatusBadge map={TS} value={t.status} /> },
        { key: 'approvedAt', label: 'Aprovado em', render: (t) => dateTimeBR(t.approvedAt) }, { key: 'legal', label: 'Revisão jurídica', render: (t) => <span className="small">{t.legalReviewNotes ?? '—'}</span> },
        { key: 'act', label: '', render: (t) => <span className="flex">{t.status === 'DRAFT' && <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); setApproveId(t.id); }}>Aprovar</button>}{t.status !== 'ARCHIVED' && <button className="btn sm" onClick={(e) => { e.stopPropagation(); archive.mutate(t.id); }}>Arquivar</button>}</span> },
      ]} />
      {editing && (
        <Modal title={editing === 'new' ? 'Novo modelo' : `Editar modelo (${(editing as Template).status === 'APPROVED' ? 'gera nova versão' : 'rascunho'})`} onClose={() => setEditing(null)} wide>
          <Field label="Nome"><input {...f.bind('name')} /></Field>
          <div className="grid cols-2">
            <Field label="Conteúdo" help="Linhas iniciadas por “# ” são títulos e “## ” subtítulos. Use {{campo}} para preencher automaticamente."><textarea style={{ minHeight: 420, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} {...f.bind('content')} /></Field>
            <div><strong className="small">Marcadores disponíveis</strong><div style={{ maxHeight: 440, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>{q.data!.placeholders.map((p) => <div key={p.key} className="small" style={{ padding: '2px 0' }}><span className="mono" style={{ cursor: 'pointer', color: 'var(--blue)' }} onClick={() => f.set('content', `${f.values.content}{{${p.key}}}`)}>{`{{${p.key}}}`}</span> — {p.label}</div>)}</div></div>
          </div>
          <Field label="Notas da revisão jurídica"><input {...f.bind('legalReviewNotes')} /></Field>
          <div className="form-actions"><button className="btn" onClick={doPreview}>Pré-visualizar</button><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Salvar</button></div>
        </Modal>
      )}
      {preview && <Modal title="Pré-visualização do modelo" onClose={() => setPreview(null)} wide><div className="doc-preview" dangerouslySetInnerHTML={{ __html: preview }} /></Modal>}
      {approveId && (
        <Modal title="Aprovar modelo após revisão jurídica" onClose={() => setApproveId(null)}>
          <Field label="Registro da revisão jurídica (quem revisou, data, observações)"><textarea value={legal} onChange={(e) => setLegal(e.target.value)} /></Field>
          <div className="form-actions"><button className="btn" onClick={() => setApproveId(null)}>Cancelar</button><button className="btn primary" disabled={approve.isPending || legal.length < 5} onClick={() => approve.mutate()}>Aprovar</button></div>
        </Modal>
      )}
    </div>
  );
}
