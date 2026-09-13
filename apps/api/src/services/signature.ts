import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Integração com provedor de assinatura eletrônica.
 * O adaptador "mock" simula o provedor para demonstração; provedores reais (Clicksign, D4Sign, ZapSign)
 * devem implementar esta interface e validar webhooks com SIGNATURE_WEBHOOK_SECRET.
 */
export interface SignerInput { name: string; email: string | null; document: string | null; role: string }
export interface Envelope { externalId: string; signUrl?: string; raw?: unknown }

export interface SignatureProvider {
  name: string;
  createEnvelope(input: { documentId: string; title: string; pdf: Buffer; signers: SignerInput[] }): Promise<Envelope>;
  cancelEnvelope(externalId: string): Promise<void>;
}

class MockSignatureProvider implements SignatureProvider {
  name = 'mock';
  async createEnvelope(input: { documentId: string; title: string; signers: SignerInput[] }): Promise<Envelope> {
    return { externalId: `mock-env-${crypto.randomUUID()}`, signUrl: `${config.appUrl}/portal#assinatura-simulada`, raw: { title: input.title, signers: input.signers.length } };
  }
  async cancelEnvelope() {}
}

export const signatureProvider: SignatureProvider = new MockSignatureProvider();
export const signatureConfigured = () => config.signature.provider !== 'mock';
