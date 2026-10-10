export const LOAN_STATUS: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: 'Proposta', tone: 'neutral' },
  UNDER_REVIEW: { label: 'Em avaliação', tone: 'info' },
  APPROVED: { label: 'Aprovado', tone: 'info' },
  REJECTED: { label: 'Rejeitado', tone: 'danger' },
  AWAITING_SIGNATURE: { label: 'Aguardando assinatura', tone: 'warning' },
  SIGNED: { label: 'Assinado', tone: 'info' },
  ACTIVE: { label: 'Em andamento', tone: 'success' },
  PAID: { label: 'Quitado', tone: 'success' },
  RENEGOTIATED: { label: 'Renegociado', tone: 'neutral' },
  CANCELLED: { label: 'Cancelado', tone: 'danger' },
};

export const INSTALLMENT_STATUS: Record<string, { label: string; tone: string }> = {
  UPCOMING: { label: 'A vencer', tone: 'neutral' },
  DUE_TODAY: { label: 'Vence hoje', tone: 'warning' },
  OVERDUE: { label: 'Vencida', tone: 'danger' },
  PARTIAL: { label: 'Parcialmente paga', tone: 'warning' },
  PAID: { label: 'Quitada', tone: 'success' },
  RENEGOTIATED: { label: 'Renegociada', tone: 'neutral' },
  CANCELLED: { label: 'Cancelada', tone: 'neutral' },
  PENDING: { label: 'Pendente', tone: 'neutral' },
};

export const CONTRACT_STATUS: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  IN_REVIEW: { label: 'Em revisão', tone: 'info' },
  AWAITING_SIGNATURE: { label: 'Aguardando assinatura', tone: 'warning' },
  SIGNED: { label: 'Assinado', tone: 'success' },
  CANCELLED: { label: 'Cancelado', tone: 'danger' },
};

export const PAYMENT_STATUS: Record<string, { label: string; tone: string }> = {
  CONFIRMED: { label: 'Confirmado', tone: 'success' },
  PENDING_REVIEW: { label: 'Aguardando conferência', tone: 'warning' },
  REJECTED: { label: 'Rejeitado', tone: 'danger' },
  REVERSED: { label: 'Estornado', tone: 'neutral' },
};

export const REMINDER_STATUS: Record<string, { label: string; tone: string }> = {
  SCHEDULED: { label: 'Agendado', tone: 'info' },
  SENT: { label: 'Enviado', tone: 'success' },
  FAILED: { label: 'Falhou', tone: 'danger' },
  CANCELLED: { label: 'Cancelado', tone: 'neutral' },
  SKIPPED: { label: 'Ignorado', tone: 'neutral' },
};

export const COMPANY_STATUS: Record<string, { label: string; tone: string }> = {
  TRIAL: { label: 'Período de teste', tone: 'info' },
  ACTIVE: { label: 'Ativa', tone: 'success' },
  SUSPENDED: { label: 'Suspensa', tone: 'danger' },
  CANCELLED: { label: 'Cancelada', tone: 'neutral' },
};

export const INVOICE_STATUS: Record<string, { label: string; tone: string }> = {
  OPEN: { label: 'Em aberto', tone: 'info' },
  PAID: { label: 'Paga', tone: 'success' },
  OVERDUE: { label: 'Vencida', tone: 'danger' },
  CANCELLED: { label: 'Cancelada', tone: 'neutral' },
};

export const PAYMENT_METHOD: Record<string, string> = { PIX: 'Pix', BOLETO: 'Boleto', CASH: 'Dinheiro', TRANSFER: 'Transferência', CARD: 'Cartão', OTHER: 'Outro' };
export const PERIODICITY: Record<string, string> = { MONTHLY: 'Mensal', BIWEEKLY: 'Quinzenal', WEEKLY: 'Semanal', DAILY: 'Diária' };
export const CALC_METHOD: Record<string, string> = { PRICE: 'Tabela Price (parcelas fixas)', SAC: 'SAC (amortização constante)', SIMPLE: 'Juros simples' };
export const ROLE: Record<string, string> = { PLATFORM_OWNER: 'Proprietário da plataforma', COMPANY_ADMIN: 'Administrador', FINANCE: 'Financeiro', COLLECTION: 'Atendimento/Cobrança', CLIENT: 'Cliente' };
export const CHANNEL: Record<string, string> = { EMAIL: 'E-mail', SMS: 'SMS', PORTAL: 'Portal' };

/** Situação dos empréstimos sobre saldo: verde em dia, amarelo vence hoje/semana, vermelho atrasado, cinza quitado. */
export const LOAN_DISPLAY: Record<string, string> = { ON_TIME: 'Em dia', DUE_TODAY: 'Vence hoje', DUE_THIS_WEEK: 'Vence esta semana', OVERDUE: 'Atrasado', PAID: 'Quitado' };
export const BILLING_TYPE: Record<string, { label: string; hint: string }> = {
  INTEREST_ONLY: { label: 'Só juros', hint: 'Juros a cada período e o valor emprestado no final' },
  FIXED_INSTALLMENTS: { label: 'Parcelas fixas', hint: 'Parcelas iguais com juros e amortização' },
  SINGLE_PAYMENT: { label: 'Pagamento único', hint: 'Tudo (valor + juros) no vencimento' },
};
export const RATE_PERIOD: Record<string, string> = { MONTHLY: 'ao mês', WEEKLY: 'por semana', BIWEEKLY: 'por quinzena', DAILY: 'ao dia' };
export const RATE_PERIOD_NAME: Record<string, string> = { MONTHLY: 'Mensal', WEEKLY: 'Semanal', BIWEEKLY: 'Quinzenal', DAILY: 'Diária' };
export const PERIOD_STATUS: Record<string, { label: string; st: string }> = {
  PAID: { label: 'Pago', st: 'PAID' }, OVERDUE: { label: 'Atrasado', st: 'OVERDUE' }, DUE_TODAY: { label: 'Vence hoje', st: 'DUE_TODAY' },
  UPCOMING: { label: 'A vencer', st: 'ON_TIME' }, PROJECTED: { label: 'Previsto', st: 'ON_TIME' }, ACCRUING: { label: 'Juros do período', st: 'ON_TIME' },
};
