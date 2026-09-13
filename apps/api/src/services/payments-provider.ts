import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Provedor de pagamentos (Pix e boleto) com cobrança identificada por parcela.
 * O adaptador "mock" simula a emissão para demonstração. Um provedor real deve implementar esta
 * interface e enviar webhooks assinados (HMAC-SHA256 do corpo com PAYMENTS_WEBHOOK_SECRET no header x-signature).
 */
export interface ChargeRequest { installmentId: string; type: 'PIX' | 'BOLETO'; amount: string; dueDate: Date; payer: { name: string; document: string; email?: string | null }; description: string }
export interface ChargeResult { externalId: string; payload: Record<string, string>; expiresAt: Date | null }

export interface PaymentProvider {
  name: string;
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  cancelCharge(externalId: string): Promise<void>;
}

class MockPaymentProvider implements PaymentProvider {
  name = 'mock';
  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    const externalId = `mock-${req.type.toLowerCase()}-${crypto.randomUUID()}`;
    if (req.type === 'PIX') {
      const payload = `00020126580014BR.GOV.BCB.PIX0136${externalId.slice(0, 36)}52040000530398654${req.amount.length.toString().padStart(2, '0')}${req.amount}5802BR5913DEMONSTRACAO6009SAO PAULO62070503***6304ABCD`;
      return { externalId, payload: { copiaECola: payload, qrCodeText: payload, instrucoes: 'Cobrança Pix simulada (provedor de demonstração).' }, expiresAt: new Date(Date.now() + 24 * 3600 * 1000) };
    }
    const digits = crypto.randomBytes(24).toString('hex').replace(/\D/g, '').padEnd(47, '0').slice(0, 47);
    const line = `${digits.slice(0, 5)}.${digits.slice(5, 10)} ${digits.slice(10, 15)}.${digits.slice(15, 21)} ${digits.slice(21, 26)}.${digits.slice(26, 32)} ${digits.slice(32, 33)} ${digits.slice(33, 47)}`;
    return { externalId, payload: { linhaDigitavel: line, url: `${config.apiUrl}/api/mock/boleto/${externalId}`, instrucoes: 'Boleto simulado (provedor de demonstração).' }, expiresAt: req.dueDate };
  }
  async cancelCharge() {}
}

export const paymentProvider: PaymentProvider = new MockPaymentProvider();
export const paymentsConfigured = () => config.payments.provider !== 'mock';

/** Formato normalizado de evento de webhook (adaptadores reais convertem para este formato). */
export interface NormalizedEvent { eventId: string; type: 'charge.paid' | 'charge.expired' | 'charge.failed' | 'charge.cancelled' | 'unknown'; externalChargeId: string; amount?: string; paidAt?: string; feeAmount?: string; netAmount?: string; raw: unknown }

export function normalizeEvent(provider: string, body: unknown): NormalizedEvent {
  const b = body as Record<string, unknown>;
  if (provider === 'mock') {
    return { eventId: String(b.id ?? ''), type: (b.type as NormalizedEvent['type']) ?? 'unknown', externalChargeId: String(b.chargeId ?? ''), amount: b.amount ? String(b.amount) : undefined, paidAt: b.paidAt ? String(b.paidAt) : undefined, feeAmount: b.fee ? String(b.fee) : undefined, netAmount: b.netAmount ? String(b.netAmount) : undefined, raw: body };
  }
  throw new Error(`Provedor de pagamentos não suportado: ${provider}`);
}
