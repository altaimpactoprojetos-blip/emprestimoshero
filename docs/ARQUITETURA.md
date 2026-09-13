# Arquitetura

## Visão geral

- **API** (`apps/api`): Express 5 + Prisma. Rotas em `src/modules/*`, regras financeiras puras em `src/domain/*`, integrações em `src/services/*`.
- **Worker** (`apps/api/src/worker.ts`): processo separado com `node-cron`. Executa cobranças (5 min), expiração de cobranças, fechamento mensal (diário 00:10 UTC, fecha o mês anterior quando ainda não fechado) e backup (03:30 UTC).
- **Web** (`apps/web`): SPA React. Token de acesso em memória (15 min) e refresh token rotativo em cookie httpOnly (`/api/auth`). Menu lateral no computador; no celular, menu retrátil e tabelas convertidas em cartões.

## Isolamento entre empresas

- Toda tabela de negócio possui `companyId`. Todas as consultas passam pelo `companyId` do usuário autenticado (`companyOf(req)`); identificadores de outra empresa retornam 404.
- Arquivos privados são gravados com prefixo `companyId/` e só são servidos por rotas autenticadas (`/api/company/files/:id`, PDFs de contrato/recibo). Nada é servido publicamente, exceto o logo da empresa.
- Relatórios, fechamentos, automações de cobrança e webhooks operam por empresa (o webhook identifica a empresa pela cobrança emitida).
- O financeiro das assinaturas do software (`Plan`, `Subscription`, `SubscriptionInvoice`) é separado do financeiro dos empréstimos (`Loan`, `Installment`, `Payment`, `Charge`).
- Testes de isolamento: `apps/api/tests/*.api.test.ts` criam duas empresas e verificam acesso cruzado.

## Perfis e permissões

- Perfis: `PLATFORM_OWNER`, `COMPANY_ADMIN`, `FINANCE`, `COLLECTION`, `CLIENT`.
- Permissões (`src/lib/permissions.ts`): visualizar/cadastrar clientes, simular/aprovar/liberar empréstimos, contratos, registrar/estornar/conferir pagamentos, conceder descontos, renegociar, cobranças, relatórios, exportar, usuários, configurações, auditoria.
- A empresa pode redefinir as permissões dos perfis Financeiro e Atendimento (`RolePermission`) e conceder/negar permissões individuais por usuário.
- Cada rota verifica a permissão com `requirePermission`. O administrador da empresa tem acesso completo; o proprietário só acessa `/api/platform`.

## Segurança

- Senhas com bcrypt; política mínima de 8 caracteres com letras e números; senha provisória obriga troca.
- 2FA TOTP (segredo criptografado com AES-256-GCM via `ENCRYPTION_KEY`); login em duas etapas com token temporário de 5 minutos.
- Recuperação de senha por token de uso único (60 min).
- Limite de tentativas nas rotas de login e recuperação (rate limit).
- Registro de ações (`AuditLog`) com usuário, IP, entidade, dados antes/depois.
- Webhooks validados por HMAC-SHA256 sobre o corpo bruto; eventos processados uma única vez (`WebhookEvent` único por provedor + id).
- Links de mensagens levam a `/portal/:empresa/acesso?token=...` (token com hash no banco, validade de 7 dias) e exigem que o cliente possua acesso ao portal.

## Modelo de dados (resumo)

`Company` → `User`, `Client` → `Loan` → `Installment` → `Payment`/`Charge`/`Reminder`; `Loan` → `Contract` (versões, aditivos, signatários); `ContractTemplate` versionado; `CollectionSettings`/`MessageTemplate` por empresa; `MonthlyReport` versionado; `Expense`; `ServiceRequest`, `Notification`, `ClientAccessToken` para o portal; `IntegrationIssue` e `WebhookEvent` para operação.

## Estados

- Empréstimo: `DRAFT → UNDER_REVIEW → APPROVED → AWAITING_SIGNATURE → SIGNED → ACTIVE → PAID | RENEGOTIATED`, além de `REJECTED` e `CANCELLED`. Avaliação, aprovação, assinatura e liberação são eventos distintos (`LoanEvent`).
- Contrato: `DRAFT → IN_REVIEW → AWAITING_SIGNATURE → SIGNED`, ou `CANCELLED`. Assinado não é alterado; gera-se aditivo (`kind = ADDENDUM`, `parentContractId`).
- Parcela: `PENDING | PARTIAL | PAID | RENEGOTIATED | CANCELLED`; situação exibida (a vencer, vence hoje, vencida, parcial, quitada) é calculada na data.
- Pagamento: `CONFIRMED | PENDING_REVIEW | REJECTED | REVERSED`; origem `MANUAL | PROVIDER | CLIENT_UPLOAD | PAYOFF | RENEGOTIATION`.
- Lembrete: `SCHEDULED | SENT | FAILED | CANCELLED | SKIPPED` com tentativas registradas.
