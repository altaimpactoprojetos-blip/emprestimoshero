# Operação e manutenção

## Produção

1. Configure `apps/api/.env` (use `openssl rand -hex 32` para `ENCRYPTION_KEY` e um `JWT_SECRET` longo; `COOKIE_SECURE=true`; `APP_URL`/`API_URL` públicos; `CORS_ORIGINS`).
2. `npm ci && npm run build`.
3. `npm run db:migrate -w apps/api` (aplica migrações sem interação).
4. Inicie a API (`npm run start -w apps/api`) e o worker (`npm run start:worker -w apps/api`) como serviços separados (systemd, PM2 ou contêineres). O worker precisa rodar continuamente para as cobranças automáticas funcionarem com o navegador fechado.
5. Sirva `apps/web/dist` por um servidor estático (nginx) com proxy de `/api` para a API. O `docker-compose.yml` traz essa configuração.
6. Coloque a API atrás de HTTPS. Os cookies de sessão exigem HTTPS quando `COOKIE_SECURE=true`.

## Worker

- Cobranças: `WORKER_CRON_COLLECTIONS` (padrão a cada 5 minutos). Para cada empresa com automação ativa, agenda etapas cujo dia-alvo está entre ontem e os próximos 3 dias e dispara as que chegaram ao horário. Reavalia a parcela antes de cada envio; respeita janela de horário/dias no fuso da empresa, limite por cliente/dia e preferências de contato; até 3 tentativas com 30 min de intervalo; falhas viram pendências.
- Fechamento mensal: `WORKER_CRON_MONTHLY_CLOSE` (diário). Gera o relatório do mês anterior para cada empresa que ainda não o possui (`automatic = true`). Fechamentos manuais criam novas versões.
- Backup: diário às 03:30 UTC com `pg_dump` em `BACKUP_PATH`, retenção `BACKUP_RETENTION_DAYS`.

## Backups e restauração verificável

- Manual: `npm run db:backup -w apps/api`.
- Verificação: `npm run db:restore-check -w apps/api` restaura o backup mais recente em um banco temporário, confere contagens (empresas, empréstimos, pagamentos) e remove o banco temporário. Execute periodicamente (ex.: semanal) e guarde os backups também fora do servidor (armazenamento em nuvem).
- Os arquivos privados (`STORAGE_LOCAL_PATH`) devem ser incluídos na rotina de backup do servidor (rsync/snapshot).

## LGPD

- Dados pessoais coletados: identificação, contato, endereço e documentos necessários à operação de crédito. Base legal típica: execução de contrato e cumprimento de obrigação legal (a cargo da empresa contratante).
- Consentimento de canais: preferências de e-mail/SMS/portal por cliente, respeitadas pela automação; o cliente altera no portal.
- Minimização na comunicação: mensagens individuais, sem valores de dívida expostos a terceiros; links levam a área autenticada.
- Registro de ações para rastreabilidade; senhas e segredos de 2FA não são legíveis.
- Exclusão/anonimização: recomenda-se, ao término das obrigações legais, anonimizar o cadastro (nome, documento, contato) mantendo os registros financeiros agregados. Implemente uma rotina conforme a política de retenção da empresa.
- Não há envio de dados a terceiros além dos provedores configurados (e-mail, SMS, pagamento, assinatura).

## Monitoramento

- `GET /api/health` para verificação de disponibilidade.
- Pendências de integração (falhas de envio, divergências de webhook, hash de assinatura divergente) aparecem em Recebimentos › Pendências e Central de cobranças › Pendências.
- Eventos de webhook ficam em `WebhookEvent` (situação `PROCESSED`, `IGNORED`, `DUPLICATE`, `FAILED`).

## Manutenção do código

- Migrações: altere `apps/api/prisma/schema.prisma` e rode `npx prisma migrate dev --name descricao` em desenvolvimento; em produção use `prisma migrate deploy`.
- Testes: `npm test`. Cobrem cálculos financeiros, pagamentos parciais, estornos, quitação, renegociação, isolamento entre empresas, eventos duplicados de pagamento e cancelamento de lembretes após quitação.
- Novos provedores: implemente as interfaces em `apps/api/src/services/` (`PaymentProvider`, `SignatureProvider`, funções de SMS) e o normalizador de eventos de webhook.
