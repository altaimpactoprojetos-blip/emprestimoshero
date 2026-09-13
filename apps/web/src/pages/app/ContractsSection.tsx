import type { Loan } from '../../lib/types';
import { EmptyState } from '../../components/ui';
/** Substituído na etapa 3 (contratos). */
export function LoanContractsSection({ loan }: { loan: Loan; onDone: () => void }) {
  return <EmptyState title="Contratos" text={`Disponível na etapa 3. Contratos cadastrados: ${loan.contracts.length}`} />;
}
