# Plataforma de Gestão de Empréstimos (multiempresa)

Sistema web responsivo, em português do Brasil, para empresas que administram carteiras de empréstimos de dinheiro. O proprietário do software cadastra empresas e planos; cada empresa opera em ambiente isolado, com marca própria, equipe, clientes, contratos, parcelas, cobranças automáticas, relatórios mensais e portal do cliente.

## Estrutura

```
apps/api   API (Node.js 22, Express 5, TypeScript, Prisma, PostgreSQL) + worker de automações
apps/web   Interface (React 19, Vite, TypeScript), responsiva para computador, tablet e celular
docs/      Arquitetura, regras de cálculo e operação
```

## Requisitos

- Node.js 20+ (testado com 22) e npm 10+
- PostgreSQL 14+ (testado com 16)
- `pg_dump`/`pg_restore` no servidor para backups (opcional, mas recomendado)

## Instalação rápida (desenvolvimento)

```bash
npm install
cp apps/api/.env.example apps/api/.env      # ajuste DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
npm run db:migrate                            # aplica as migrações
npm run db:seed                               # dados de demonstração (opcional)
npm run dev:api                               # API em http://localhost:4000
npm run dev:worker                            # worker de cobranças/fechamento/backup
npm run dev:web                               # interface em http://localhost:5173
```

Com Docker: `docker compose up -d` sobe banco, API, worker e interface (veja `docker-compose.yml`).

### Acessos de demonstração (após `npm run db:seed`)

| Perfil | Acesso | Senha |
| --- | --- | --- |
| Proprietário da plataforma | `/login` — proprietario@plataforma.local | Senha@123 |
| Administrador da empresa "Crédito Demonstração" | `/login` — admin@demo.local | Senha@123 |
| Financeiro | `/login` — financeiro@demo.local | Senha@123 |
| Atendimento/Cobrança | `/login` — cobranca@demo.local | Senha@123 |
| Cliente (portal) | `/portal/demo/login` — CPF 111.444.777-35 | Senha@123 |

Todos os registros do seed são fictícios e trazem o sufixo "(demonstração)".

## O que está incluído (por etapa)

1. **Estrutura e acesso** — painel do proprietário (empresas, planos, mensalidades, limites, faturas do software separadas do financeiro dos empréstimos), isolamento por empresa em todas as tabelas/arquivos/relatórios/automações, perfis (proprietário, administrador, financeiro, atendimento/cobrança, cliente), matriz de permissões configurável, recuperação de senha, 2FA (TOTP) para administradores, registro de ações com usuário, data e antes/depois.
2. **Clientes e empréstimos** — cadastro com CPF/CNPJ validado e prevenção de duplicidade por empresa, documentos, ficha completa; produtos de crédito com validação jurídica; simulação com principal, taxas efetivas, juros, tarifas, IOF, CET, parcelas e total; método de cálculo explicado; eventos distintos de avaliação, aprovação, assinatura e liberação.
3. **Contratos e parcelas** — modelos editáveis e versionados aprovados após revisão jurídica, PDF com dados preenchidos automaticamente e hash SHA-256, estados de rascunho a assinado, aditivos vinculados; parcelas com filtros (a vencer, hoje, vencidas, parciais, quitadas, renegociadas), recebimento integral/parcial, comprovante, recibo em PDF, estorno justificado, renegociação sem duplicar saldo e quitação antecipada com juros pro rata.
4. **Cobranças e pagamentos** — central de cobranças com sequência configurável (padrão: 3 dias antes, no vencimento, 3 e 7 dias após), e-mail/SMS/portal, horários, fuso, dias, limite por cliente, mensagens editáveis com link seguro; worker no servidor com reavaliação antes do envio, cancelamento após quitação, pausa em contestação/renegociação e histórico de tentativas; cobranças Pix/boleto por parcela, webhooks autenticados e idempotentes, conciliação e pendências de integração.
5. **Relatórios e portal** — painel com valores emprestados, principal recuperado, juros, saldo a receber, saldo vencido, parcelas de hoje e clientes em atraso (com fórmulas); fechamento mensal automático e versionado com comparação ao mês anterior, detalhamento e exportação PDF/Excel; portal do cliente com contratos, parcelas, pagamentos, recibos, comprovantes, preferências e atendimento.

6. **Empréstimos sobre saldo devedor** (tela principal, pensada para celular) — juros de cada período sobre o saldo atual, taxa diária/semanal/quinzenal/mensal, cobrança só de juros, parcelas fixas ou pagamento único; pagamento parcial de qualquer valor com prévia (quanto vai para juros, principal e o novo saldo), juros pendentes separados ou somados ao principal; histórico com edição e exclusão recalculando tudo; atraso automático com multa e mora; painel com total na rua, juros a receber, recebidos, vencimentos de hoje/semana e atrasados; contrato de mútuo preenchido automaticamente (valor por extenso, edição antes de gerar, PDF, WhatsApp e histórico); recibo; simulador; exportação Excel/CSV e backup; dados do credor em Configurações; modo escuro. Regras em `docs/CALCULOS.md`.

## Integrações externas (dependem de configuração no servidor)

| Integração | Estado sem configuração | Como conectar |
| --- | --- | --- |
| E-mail (SMTP) | Modo "console": mensagens registradas no histórico, sem envio real | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| SMS | Modo "console" | `SMS_PROVIDER=twilio` + credenciais (ou implementar outro provedor em `apps/api/src/services/sms.ts`) |
| Pagamentos Pix/boleto | Provedor `mock`: cobranças simuladas, confirmação via "Simular pagamento" | Implementar `PaymentProvider` em `apps/api/src/services/payments-provider.ts`, definir `PAYMENTS_PROVIDER` e `PAYMENTS_WEBHOOK_SECRET`; webhook em `POST /api/webhooks/payments/:provider` (HMAC-SHA256 no header `x-signature`) |
| Assinatura eletrônica | Provedor `mock`: "Simular assinatura" na tela do contrato | Implementar `SignatureProvider` em `apps/api/src/services/signature.ts` (Clicksign, D4Sign, ZapSign etc.); webhook em `POST /api/webhooks/signature/:provider` |

O WhatsApp não é utilizado na automação de cobrança, em respeito às políticas do canal.

## Comandos úteis

```bash
npm test                       # testes (motor financeiro, isolamento, pagamentos, cobranças, webhooks, portal)
npm run typecheck              # verificação de tipos em API e Web
npm run build                  # build de produção
npm run db:backup -w apps/api  # backup com pg_dump em BACKUP_PATH
npm run db:restore-check -w apps/api  # restaura o último backup em banco temporário e confere
```

Os testes usam o banco `TEST_DATABASE_URL` (padrão: `emprestimoshero_test` local) e o limpam a cada execução.

## Documentação

- `docs/ARQUITETURA.md` — módulos, modelo de dados, segurança e isolamento
- `docs/CALCULOS.md` — regras financeiras (métodos, IOF, CET, arredondamento, atraso, alocação, quitação, renegociação)
- `docs/OPERACAO.md` — produção, worker, backups, LGPD e manutenção
