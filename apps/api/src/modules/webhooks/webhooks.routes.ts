import { Router } from 'express';
import { config } from '../../config.js';
import { hmacVerify } from '../../lib/crypto.js';
import { processPaymentEvent } from '../payments/charges.service.js';
import { prisma } from '../../lib/prisma.js';
import { markSigned } from '../contracts/contracts.service.js';

/**
 * Webhooks de provedores externos. O corpo chega bruto (express.raw) para validar a assinatura HMAC.
 * Sempre responde 200 após registrar o evento, para o provedor não reenviar indefinidamente;
 * falhas de processamento ficam registradas em WebhookEvent e IntegrationIssue.
 */
export const webhooksRouter = Router();

const rawBody = (req: { body: unknown }) => (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));

webhooksRouter.post('/payments/:provider', async (req, res) => {
  const provider = String(req.params.provider);
  if (provider !== config.payments.provider) return res.status(404).json({ error: 'Provedor não configurado' });
  const body = rawBody(req);
  if (!hmacVerify(config.payments.webhookSecret, body, req.headers['x-signature'] as string | undefined)) return res.status(401).json({ error: 'Assinatura inválida' });
  let json: unknown;
  try { json = JSON.parse(body); } catch { return res.status(400).json({ error: 'JSON inválido' }); }
  const result = await processPaymentEvent(provider, json);
  res.json(result);
});

webhooksRouter.post('/signature/:provider', async (req, res) => {
  const provider = String(req.params.provider);
  if (provider !== config.signature.provider) return res.status(404).json({ error: 'Provedor não configurado' });
  const body = rawBody(req);
  if (!hmacVerify(config.signature.webhookSecret, body, req.headers['x-signature'] as string | undefined)) return res.status(401).json({ error: 'Assinatura inválida' });
  let json: { id?: string; type?: string; envelopeId?: string; documentHash?: string; signers?: never[] };
  try { json = JSON.parse(body); } catch { return res.status(400).json({ error: 'JSON inválido' }); }
  const eventId = json.id ?? `${json.envelopeId}-${json.type}`;
  try {
    await prisma.webhookEvent.create({ data: { provider: `signature:${provider}`, externalEventId: eventId, eventType: json.type ?? 'unknown', payload: json as never } });
  } catch { return res.json({ status: 'DUPLICATE' }); }
  try {
    if (json.type === 'envelope.signed' && json.envelopeId) {
      const c = await prisma.contract.findFirst({ where: { signatureProvider: provider, signatureExternalId: json.envelopeId } });
      if (c) await markSigned(c.id, { provider, documentHash: json.documentHash, signers: json.signers, raw: json }, null);
    }
    await prisma.webhookEvent.updateMany({ where: { provider: `signature:${provider}`, externalEventId: eventId }, data: { status: 'PROCESSED', processedAt: new Date() } });
    res.json({ status: 'PROCESSED' });
  } catch (e) {
    await prisma.webhookEvent.updateMany({ where: { provider: `signature:${provider}`, externalEventId: eventId }, data: { status: 'FAILED', error: (e as Error).message, processedAt: new Date() } });
    res.json({ status: 'FAILED', detail: (e as Error).message });
  }
});
