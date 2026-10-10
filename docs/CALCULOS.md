# Regras de cálculo

Implementadas em `apps/api/src/domain/finance.ts` e `apps/api/src/domain/installment.ts`, com `decimal.js` (30 dígitos de precisão nos cálculos intermediários). Os mesmos valores são usados na simulação, no cadastro, no contrato, nas parcelas e nos relatórios: a simulação é recalculada no cadastro e gravada na tabela `Loan`/`Installment`; contratos e relatórios leem esses valores gravados.

## Arredondamento

- Regra `HALF_UP_2_LAST_ADJUST`: valores em centavos com arredondamento HALF_UP; a última parcela absorve o resíduo para que a soma das amortizações seja exatamente o principal e a soma dos juros seja o total de juros.
- Taxas gravadas com 6 casas decimais.

## Métodos

- **Tabela Price**: parcela fixa `PMT = P × i / (1 − (1+i)^−n)`; juros do período = saldo × i; amortização = PMT − juros.
- **SAC**: amortização constante `P / n`; juros = saldo × i; parcelas decrescentes.
- **Juros simples**: juros totais = `P × i × n`, distribuídos igualmente; amortização constante.
- Taxa por período: taxa mensal informada; para quinzenal/semanal/diária usa-se a equivalente composta `(1 + i_m)^(dias/30) − 1` (15, 7 e 1 dias).
- Os juros por período são nominais, independentemente do intervalo entre liberação e primeiro vencimento; o efeito do prazo real aparece no CET.
- Vencimentos mensais mantêm o dia; em meses mais curtos, usa-se o último dia.

## Tarifas, IOF e CET

- Tarifa de abertura = valor fixo + percentual do valor solicitado.
- IOF = alíquota fixa × principal + alíquota diária × cada amortização × dias até o vencimento (limitado a 365). Alíquotas configuráveis por produto; a aplicação de tributos deve ser validada juridicamente pela empresa.
- Modo **descontado**: principal = valor solicitado; liberado = solicitado − tarifa − IOF.
- Modo **financiado**: liberado = solicitado; principal = solicitado + tarifa + IOF (iterado até estabilizar, pois o IOF incide sobre o próprio financiamento).
- CET: taxa interna de retorno do fluxo (valor liberado na data de liberação contra as parcelas nas datas reais), base 30 dias, por bissecção; anual = `(1 + r)^12 − 1`.
- Taxa efetiva anual = `(1 + i_m)^12 − 1`.

## Atraso, alocação e pagamentos parciais

- Base em aberto = principal + juros da parcela − principal pago − juros pagos.
- Multa: percentual único sobre a base em aberto ao entrar em atraso (não se repete após um pagamento parcial em atraso).
- Mora: taxa mensal ÷ 30 por dia sobre a base em aberto, contada desde o vencimento ou desde o último pagamento. Encargos apurados e não pagos em um pagamento parcial ficam "carregados" na parcela.
- Alocação de cada recebimento: **encargos → juros → principal**; descontos seguem a mesma ordem. Valor + desconto não pode exceder o saldo.
- Cada pagamento registra principal, juros, encargos e desconto; o recibo mostra a destinação.

## Estorno

- O pagamento original é preservado com situação `REVERSED`, data, responsável e justificativa; a parcela volta ao saldo anterior (valores pagos subtraídos, encargos recalculados). Empréstimo quitado volta a `ACTIVE`.

## Quitação antecipada

- Parcelas vencidas ou vencendo hoje: saldo integral com encargos.
- Parcelas a vencer: principal integral + juros proporcionais aos dias decorridos do período em curso (`juros × dias decorridos / dias do período`); o restante dos juros é dispensado e registrado como desconto.
- Gera um pagamento por parcela (origem `PAYOFF`) e encerra o empréstimo (`PAID`), cancelando lembretes e cobranças pendentes.

## Renegociação

- Parcelas selecionadas são encerradas como `RENEGOTIATED` com um lançamento de baixa sem receita (origem `RENEGOTIATION`, valor zero, desconto = saldo transferido).
- O saldo (com encargos até a data-base, menos desconto) vira o principal de um novo empréstimo vinculado (`parentLoanId`), sem novo desembolso. O original passa a `RENEGOTIATED` quando não restam parcelas em aberto. A dívida não é duplicada e o histórico é preservado.

## Indicadores

- Inadimplência (valor) = saldo vencido ÷ saldo total a receber × 100.
- Inadimplência (clientes) = clientes com parcela em atraso ÷ clientes com contrato ativo × 100.
- Inadimplência 30+ = saldo com mais de 30 dias de atraso ÷ saldo total a receber × 100.
- Principal recuperado é devolução de capital e não é contabilizado como lucro; o resultado do mês = juros + encargos − despesas.

## Empréstimos sobre saldo devedor (engine `BALANCE`)

Implementação: `apps/api/src/domain/balance.ts` (testes em `apps/api/tests/balance.test.ts`).

- **Taxa por período**: a taxa informada vale exatamente para o período escolhido (diário, semanal, quinzenal ou mensal), sem conversão.
- **Juros sobre o saldo atual**: no início de cada período, juros = principal em aberto × taxa (arredondado em centavos). Os juros valem pelo período inteiro, mesmo que o pagamento ocorra antes do vencimento.
- **Ordem de abatimento**: encargos de atraso → juros pendentes (mais antigos primeiro) → principal.
- **Juros não pagos**: ficam pendentes. No início do período seguinte, conforme a configuração, ficam **separados** (não geram juros) ou são **somados ao principal**.
- **Pagamento no dia do vencimento** conta no período que vence. Pagamentos com data futura ou acima do saldo são recusados.
- **Tipos de cobrança**:
  - *Só juros*: os juros vencem ao fim de cada período; o principal vence na data final.
  - *Parcelas fixas*: parcela = juros do período + amortização Price sobre o saldo e os períodos restantes. Pagamento extra reduz as próximas parcelas e mantém o prazo.
  - *Pagamento único*: principal e juros acumulados vencem na data final.
- **Prazo**: número de períodos entre a data do empréstimo e o vencimento, arredondado para cima. Depois do vencimento final, os juros continuam correndo a cada período enquanto houver saldo.
- **Atraso**: o empréstimo fica *atrasado* no dia seguinte ao vencimento não pago. Multa (%) única sobre cada valor que vence sem pagamento. Mora (% ao mês ÷ 30 × dias) sobre o valor vencido. Os encargos são somados ao saldo.
- **Recálculo completo**: editar ou excluir um pagamento, ou alterar as condições, reprocessa o empréstimo desde o início e regrava a destinação (juros/principal/encargos) e o saldo após cada pagamento.
- **Total a receber**: saldo de hoje + juros futuros previstos até o vencimento, supondo pagamentos em dia.

Exemplo validado em teste: R$ 1.000 a 10% ao mês. Juros do mês: R$ 100. O cliente paga R$ 400: R$ 100 quitam os juros e R$ 300 abatem o principal. Novo saldo: R$ 700. Juros do mês seguinte: R$ 70.
