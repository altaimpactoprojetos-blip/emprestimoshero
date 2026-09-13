import { prisma, type Tx } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { renderTemplate, parseToBlocks, blocksToHtml, numberToWordsBRL, DEFAULT_CONTRACT_TEMPLATE, type TemplateVars } from '../../domain/template.js';
import { renderPdf } from '../../services/pdf.js';
import { storeFile } from '../../lib/storage.js';
import { sha256 } from '../../lib/crypto.js';
import { formatBRDate, formatBRDateTime, todayIn } from '../../lib/dates.js';
import { formatBRL, formatPct } from '../../lib/money.js';
import { audit } from '../../lib/audit.js';
import type { AuthContext } from '../../middleware/auth.js';
import { addEvent } from '../loans/loans.service.js';
import { signatureProvider } from '../../services/signature.js';
import { maskDoc } from '../../lib/text.js';

const PERIOD_LABEL: Record<string, string> = { MONTHLY: 'mensal', BIWEEKLY: 'quinzenal', WEEKLY: 'semanal', DAILY: 'diária' };
const METHOD_LABEL: Record<string, string> = { PRICE: 'Tabela Price (parcelas fixas)', SAC: 'SAC (amortização constante)', SIMPLE: 'juros simples' };

export async function ensureDefaultTemplate(companyId: string) {
  const count = await prisma.contractTemplate.count({ where: { companyId } });
  if (count === 0) {
    await prisma.contractTemplate.create({ data: { companyId, name: 'Contrato de mútuo padrão', content: DEFAULT_CONTRACT_TEMPLATE, status: 'DRAFT', legalReviewNotes: 'Modelo inicial sugerido. Deve ser revisado juridicamente e aprovado pela empresa antes do uso.' } });
  }
}

export async function buildVars(companyId: string, loanId: string): Promise<{ vars: TemplateVars; schedule: Array<[string, string, string, string, string]>; signers: string[]; loan: NonNullable<Awaited<ReturnType<typeof loadLoanForContract>>> }> {
  const loan = await loadLoanForContract(companyId, loanId);
  const company = loan.company;
  const c = loan.client;
  const settings = (company.settings ?? {}) as { paymentInstructions?: string; pixKey?: string };
  const addr = (p: { addressStreet?: string | null; addressNumber?: string | null; addressComplement?: string | null; addressDistrict?: string | null; addressCity?: string | null; addressState?: string | null; addressZip?: string | null }) => [p.addressStreet, p.addressNumber, p.addressComplement, p.addressDistrict, p.addressCity && `${p.addressCity}/${p.addressState ?? ''}`, p.addressZip && `CEP ${p.addressZip}`].filter(Boolean).join(', ') || 'não informado';
  const today = todayIn(company.timezone);
  const vars: TemplateVars = {
    'empresa.nome': company.name,
    'empresa.razao_social': company.legalName ?? company.name,
    'empresa.cnpj': maskDoc(company.cnpj) || 'não informado',
    'empresa.endereco': company.address ?? 'não informado',
    'cliente.nome': c.name,
    'cliente.documento': maskDoc(c.document),
    'cliente.endereco': addr(c),
    'cliente.email': c.email ?? 'não informado',
    'cliente.telefone': c.phone ?? 'não informado',
    'contrato.numero': String(loan.number),
    'contrato.data': formatBRDate(today),
    'valor.solicitado': formatBRL(loan.requestedAmount),
    'valor.principal': formatBRL(loan.principalAmount),
    'valor.liberado': formatBRL(loan.disbursedAmount),
    'valor.liberado_extenso': numberToWordsBRL(Number(loan.disbursedAmount)),
    'valor.tarifa': formatBRL(loan.originationFee),
    'valor.iof': formatBRL(loan.iofAmount),
    'valor.total': formatBRL(loan.totalAmount),
    'valor.juros': formatBRL(loan.totalInterest),
    'parcelas.quantidade': String(loan.installmentsCount),
    'parcelas.valor': formatBRL(loan.installmentAmount),
    'parcelas.periodicidade': PERIOD_LABEL[loan.periodicity],
    'parcelas.primeiro_vencimento': formatBRDate(loan.installments[0]?.dueDate),
    'parcelas.ultimo_vencimento': formatBRDate(loan.installments.at(-1)?.dueDate),
    'taxa.mensal': formatPct(loan.effectiveMonthlyRate),
    'taxa.anual': formatPct(loan.effectiveAnnualRate),
    'taxa.cet_mensal': formatPct(loan.cetMonthly),
    'taxa.cet_anual': formatPct(loan.cetAnnual),
    'taxa.metodo': METHOD_LABEL[loan.calcMethod],
    'atraso.multa': formatPct(loan.lateFineRate),
    'atraso.mora': formatPct(loan.lateInterestMonthly),
    'pagamento.formas': settings.paymentInstructions || (settings.pixKey ? `Pix (chave ${settings.pixKey}), boleto ou transferência` : 'Pix, boleto ou transferência'),
    'data.liberacao': formatBRDate(loan.disbursedAt ?? loan.disbursementDate),
  };
  const schedule = loan.installments.map((i): [string, string, string, string, string] => [String(i.number), formatBRDate(i.dueDate), formatBRL(i.principalAmount), formatBRL(i.interestAmount), formatBRL(i.originalAmount)]);
  const signers = [`${c.name} — DEVEDOR(A)`, `${company.legalName ?? company.name} — CREDORA`];
  return { vars, schedule, signers, loan };
}

async function loadLoanForContract(companyId: string, loanId: string) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, companyId }, include: { client: true, company: true, installments: { orderBy: { number: 'asc' } } } });
  if (!loan) throw notFound('Empréstimo não encontrado');
  return loan;
}

export async function previewTemplate(companyId: string, content: string, loanId?: string) {
  if (loanId) {
    const { vars, schedule, signers } = await buildVars(companyId, loanId);
    return blocksToHtml(parseToBlocks(renderTemplate(content, vars), { rows: schedule }, signers));
  }
  const sample = Object.fromEntries((await import('../../domain/template.js')).TEMPLATE_PLACEHOLDERS.map((p) => [p.key, `[${p.label}]`]));
  return blocksToHtml(parseToBlocks(renderTemplate(content, sample), { rows: [['1', '[data]', '[valor]', '[valor]', '[valor]']] }, ['[Devedor]', '[Credora]']));
}

export async function generateContract(ctx: AuthContext, loanId: string, templateId: string, opts: { kind?: 'CONTRACT' | 'ADDENDUM'; parentContractId?: string; extraText?: string } = {}) {
  const companyId = ctx.companyId!;
  const template = await prisma.contractTemplate.findFirst({ where: { id: templateId, companyId } });
  if (!template) throw notFound('Modelo não encontrado');
  if (template.status !== 'APPROVED') throw badRequest('Somente modelos aprovados após revisão jurídica podem gerar contratos');
  const { vars, schedule, signers, loan } = await buildVars(companyId, loanId);
  if (['CANCELLED', 'REJECTED', 'DRAFT'].includes(loan.status) && opts.kind !== 'ADDENDUM') throw badRequest('Envie a proposta para avaliação/aprovação antes de gerar o contrato');
  const kind = opts.kind ?? 'CONTRACT';
  if (kind === 'CONTRACT') {
    const openContract = await prisma.contract.findFirst({ where: { loanId, kind: 'CONTRACT', status: { in: ['DRAFT', 'IN_REVIEW', 'AWAITING_SIGNATURE', 'SIGNED'] } } });
    if (openContract?.status === 'SIGNED') throw badRequest('Já existe contrato assinado; alterações devem ser feitas por aditivo');
    if (openContract) await prisma.contract.update({ where: { id: openContract.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Substituído por nova versão' } });
  } else if (opts.parentContractId) {
    const parent = await prisma.contract.findFirst({ where: { id: opts.parentContractId, companyId, loanId } });
    if (!parent || parent.status !== 'SIGNED') throw badRequest('Aditivo deve estar vinculado a um contrato assinado');
  }
  let content = renderTemplate(template.content, vars);
  if (kind === 'ADDENDUM') content = `# ADITIVO AO CONTRATO Nº ${vars['contrato.numero']}\n\n${opts.extraText ?? ''}\n\n${content}`;
  const version = (await prisma.contract.count({ where: { loanId } })) + 1;
  const blocks = parseToBlocks(content, { rows: schedule }, signers);
  const pdf = await renderPdf(blocks, { title: `Contrato ${vars['contrato.numero']} v${version}`, header: `${loan.company.name} · Contrato nº ${vars['contrato.numero']} · versão ${version}`, footer: 'Documento gerado eletronicamente. Integridade verificável pelo hash SHA-256 registrado no sistema.' });
  const file = await storeFile(companyId, `contrato-${loan.number}-v${version}.pdf`, 'application/pdf', pdf, ctx.userId);
  const contract = await prisma.$transaction(async (tx) => {
    const c = await tx.contract.create({
      data: { companyId, loanId, templateId: template.id, templateVersion: template.version, version, kind, status: 'DRAFT', renderedContent: content, fileId: file.id, sha256: sha256(pdf), createdById: ctx.userId, parentContractId: opts.parentContractId ?? null,
        signers: { create: [{ name: loan.client.name, document: loan.client.document, email: loan.client.email, role: 'BORROWER' }, { name: loan.company.legalName ?? loan.company.name, document: loan.company.cnpj, email: loan.company.email, role: 'LENDER' }] } },
      include: { signers: true },
    });
    await addEvent(tx, loanId, 'CONTRACT_GENERATED', ctx, { contractId: c.id, version, kind });
    await audit(ctx, { action: 'CONTRACT_GENERATE', entity: 'Contract', entityId: c.id, after: { loanId, version, kind, sha256: c.sha256 } }, tx);
    return c;
  });
  return contract;
}

export async function contractHtml(companyId: string, contractId: string) {
  const c = await prisma.contract.findFirst({ where: { id: contractId, companyId }, include: { loan: { include: { installments: { orderBy: { number: 'asc' } }, client: true, company: true } } } });
  if (!c) throw notFound('Contrato não encontrado');
  const schedule = c.loan.installments.map((i): [string, string, string, string, string] => [String(i.number), formatBRDate(i.dueDate), formatBRL(i.principalAmount), formatBRL(i.interestAmount), formatBRL(i.originalAmount)]);
  const signers = [`${c.loan.client.name} — DEVEDOR(A)`, `${c.loan.company.legalName ?? c.loan.company.name} — CREDORA`];
  return blocksToHtml(parseToBlocks(c.renderedContent, { rows: schedule }, signers));
}

export async function changeStatus(ctx: AuthContext, contractId: string, action: 'review' | 'request_signature' | 'cancel' | 'back_to_draft', reason?: string) {
  const c = await prisma.contract.findFirst({ where: { id: contractId, companyId: ctx.companyId! }, include: { signers: true, loan: true } });
  if (!c) throw notFound('Contrato não encontrado');
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    let data: Record<string, unknown> = {};
    let event: string | null = null;
    if (action === 'review') { if (c.status !== 'DRAFT') throw badRequest('Somente rascunhos vão para revisão'); data = { status: 'IN_REVIEW' }; }
    else if (action === 'back_to_draft') { if (c.status !== 'IN_REVIEW') throw badRequest('Estado inválido'); data = { status: 'DRAFT' }; }
    else if (action === 'request_signature') {
      if (!['DRAFT', 'IN_REVIEW'].includes(c.status)) throw badRequest('Contrato não está apto para assinatura');
      const file = c.fileId ? await (await import('../../lib/storage.js')).readFile(ctx.companyId!, c.fileId) : null;
      const env = await signatureProvider.createEnvelope({ documentId: c.id, title: `Contrato ${c.loan.number} v${c.version}`, pdf: file?.data ?? Buffer.alloc(0), signers: c.signers.map((s) => ({ name: s.name, email: s.email, document: s.document, role: s.role })) });
      data = { status: 'AWAITING_SIGNATURE', signatureProvider: signatureProvider.name, signatureExternalId: env.externalId, signatureEvidence: { envelope: env.raw ?? null, requestedAt: now.toISOString(), requestedBy: ctx.userName } };
      if (c.kind === 'CONTRACT' && ['APPROVED'].includes(c.loan.status)) await tx.loan.update({ where: { id: c.loanId }, data: { status: 'AWAITING_SIGNATURE' } });
      event = 'CONTRACT_SENT';
    } else if (action === 'cancel') {
      if (c.status === 'SIGNED') throw badRequest('Contrato assinado não pode ser cancelado; gere um aditivo ou novo documento vinculado');
      if (c.signatureExternalId) await signatureProvider.cancelEnvelope(c.signatureExternalId).catch(() => {});
      data = { status: 'CANCELLED', cancelledAt: now, cancelReason: reason ?? null };
      if (c.loan.status === 'AWAITING_SIGNATURE') await tx.loan.update({ where: { id: c.loanId }, data: { status: 'APPROVED' } });
    }
    const updated = await tx.contract.update({ where: { id: c.id }, data: data as never });
    if (event) await addEvent(tx, c.loanId, event, ctx, { contractId: c.id });
    await audit(ctx, { action: `CONTRACT_${action.toUpperCase()}`, entity: 'Contract', entityId: c.id, before: { status: c.status }, after: { status: updated.status, reason } }, tx);
    return updated;
  });
}

/** Registra a assinatura concluída (chamado pelo webhook do provedor ou pela simulação em desenvolvimento). */
export async function markSigned(contractId: string, evidence: { signers?: Array<{ role?: string; email?: string; name?: string; signedAt?: string; ip?: string; evidence?: unknown }>; documentHash?: string; provider?: string; raw?: unknown }, ctx: Partial<AuthContext> | null) {
  const c = await prisma.contract.findUnique({ where: { id: contractId }, include: { signers: true, loan: true } });
  if (!c) throw notFound('Contrato não encontrado');
  if (c.status === 'SIGNED') return c;
  if (c.status !== 'AWAITING_SIGNATURE') throw badRequest('Contrato não está aguardando assinatura');
  if (evidence.documentHash && c.sha256 && evidence.documentHash !== c.sha256) {
    await prisma.integrationIssue.create({ data: { companyId: c.companyId, kind: 'SIGNATURE', reference: c.id, message: 'Hash do documento assinado difere do documento gerado', details: { expected: c.sha256, received: evidence.documentHash } } });
    throw badRequest('Integridade do documento não confirmada');
  }
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    for (const s of c.signers) {
      const ev = evidence.signers?.find((x) => (x.role && x.role === s.role) || (x.email && x.email === s.email)) ?? {};
      await tx.contractSigner.update({ where: { id: s.id }, data: { signedAt: ev.signedAt ? new Date(ev.signedAt) : now, ip: ev.ip ?? null, evidence: (ev.evidence ?? ev) as never } });
    }
    const updated = await tx.contract.update({ where: { id: c.id }, data: { status: 'SIGNED', signedAt: now, signatureEvidence: { ...(c.signatureEvidence as object ?? {}), completedAt: now.toISOString(), provider: evidence.provider ?? c.signatureProvider, documentHash: evidence.documentHash ?? c.sha256, raw: evidence.raw ?? null } as never } });
    if (c.kind === 'CONTRACT' && ['APPROVED', 'AWAITING_SIGNATURE'].includes(c.loan.status)) await tx.loan.update({ where: { id: c.loanId }, data: { status: 'SIGNED', signedAt: now } });
    else if (c.loan.status !== 'ACTIVE' && c.loan.status !== 'PAID') await tx.loan.update({ where: { id: c.loanId }, data: { signedAt: c.loan.signedAt ?? now } });
    await addEvent(tx, c.loanId, 'SIGNED', ctx, { contractId: c.id, version: c.version, kind: c.kind });
    await audit({ ...ctx, companyId: c.companyId }, { action: 'CONTRACT_SIGNED', entity: 'Contract', entityId: c.id, after: { signedAt: now, provider: evidence.provider } }, tx);
    return updated;
  });
}

export { formatBRDateTime, type Tx };
