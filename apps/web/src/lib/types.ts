export interface Balance { principalOpen: string; interestOpen: string; openBase: string; daysLate: number; fine: string; lateInterest: string; chargesCarried: string; chargesDue: string; totalDue: string; displayStatus: string }
export interface Installment {
  id: string; loanId: string; number: number; dueDate: string; principalAmount: string; interestAmount: string; originalAmount: string; status: string;
  paidPrincipal: string; paidInterest: string; paidCharges: string; discountAmount: string; chargesCarried: string; fineApplied: boolean; lastPaymentAt: string | null; paidAt: string | null;
  balance: Balance; charges?: Charge[];
}
export interface Charge { id: string; provider: string; externalId: string; type: string; amount: string; status: string; payload: Record<string, string> | null; expiresAt: string | null; paidAt: string | null; feeAmount: string | null; netAmount: string | null; createdAt: string }
export interface Payment {
  id: string; loanId: string; installmentId: string; receiptNumber: number | null; amount: string; principalPortion: string; interestPortion: string; chargesPortion: string; discountAmount: string;
  method: string; status: string; source: string; paidAt: string; receivedByName: string | null; proofFileId: string | null; notes: string | null; reversedAt: string | null; reversalReason: string | null; createdAt: string;
  installment?: { number: number }; loan?: { number: number }; proofFile?: { id: string; filename: string } | null;
}
export interface Contract { id: string; loanId: string; version: number; kind: string; status: string; templateVersion: number | null; renderedContent?: string; fileId: string | null; sha256: string | null; signatureProvider: string | null; signatureExternalId: string | null; signedAt: string | null; cancelledAt: string | null; cancelReason: string | null; parentContractId: string | null; createdAt: string; signers?: Array<{ id: string; name: string; role: string; email: string | null; signedAt: string | null }>; file?: { id: string; filename: string } | null }
export interface LoanEvent { id: string; type: string; userName: string | null; data: Record<string, unknown> | null; createdAt: string }
export interface Client {
  id: string; personType: string; name: string; document: string; email: string | null; phone: string | null; birthDate: string | null; status: string;
  rg?: string | null; nationality?: string | null; maritalStatus?: string | null; profession?: string | null;
  addressStreet: string | null; addressNumber: string | null; addressComplement: string | null; addressDistrict: string | null; addressCity: string | null; addressState: string | null; addressZip: string | null; notes: string | null;
  contactPreferences: { email?: boolean; sms?: boolean; portal?: boolean }; createdAt: string;
  summary?: { openBalance: string; overdueBalance: string; maxDaysLate: number; loans: number };
}
export interface Loan {
  id: string; number: number; status: string; engine?: string; billingType?: string | null; ledgerStatus?: string | null; clientId: string; client?: { id: string; name: string; document: string } & Partial<Client>; productId: string | null; product?: { name: string } | null;
  requestedAmount: string; principalAmount: string; disbursedAmount: string; disbursementDate: string; installmentsCount: number; periodicity: string; firstDueDate: string; calcMethod: string; monthlyRate: string; chargeMode: string;
  originationFee: string; iofAmount: string; iofFixedRate: string; iofDailyRate: string; lateFineRate: string; lateInterestMonthly: string; installmentAmount: string; totalAmount: string; totalInterest: string; totalCharges: string;
  effectiveMonthlyRate: string; effectiveAnnualRate: string; cetMonthly: string; cetAnnual: string; roundingRule: string; calcExplanation: string | null;
  assessmentNotes: string | null; assessmentScore: number | null; approvedAt: string | null; rejectedReason: string | null; signedAt: string | null; disbursedAt: string | null; paidOffAt: string | null; collectionState: string; collectionPauseReason: string | null;
  parentLoanId: string | null; parentLoan?: { id: string; number: number } | null; children?: Array<{ id: string; number: number; status: string }>; notes: string | null; createdAt: string;
  installments: Installment[]; payments: Payment[]; contracts: Contract[]; events: LoanEvent[];
  summary: { openBalance: string; principalOpen: string; overdueBalance: string; overdueCount: number; maxDaysLate: number; paidCount: number; totalPaid: string; principalPaid: string; interestPaid: string; chargesPaid: string; signedContract: boolean; openInstallments?: number; paidInstallments?: number; progress?: number; nextDue?: { date: string; amount: string } | null };
  today?: string;
}
export interface Simulation {
  requestedAmount: string; principalAmount: string; disbursedAmount: string; originationFee: string; iofAmount: string; totalCharges: string; installmentAmount: string; totalAmount: string; totalInterest: string;
  monthlyRate: string; periodRate: string; effectiveMonthlyRate: string; effectiveAnnualRate: string; cetMonthly: string; cetAnnual: string; roundingRule: string; explanation: string;
  schedule: Array<{ number: number; dueDate: string; days: number; principal: string; interest: string; amount: string; balanceAfter: string }>;
}
export interface Product { id: string; name: string; calcMethod: string; monthlyRate: string; originationFee: string; originationFeeRate: string; iofFixedRate: string; iofDailyRate: string; chargeMode: string; lateFineRate: string; lateInterestMonthly: string; legalNotes: string | null; legallyReviewed: boolean; active: boolean }

// ---------- Empréstimos sobre saldo devedor ----------
export interface LedgerPeriod { number: number; startDate: string; dueDate: string; openingPrincipal: string; interest: string; principalDue: string; amountDue: string; remaining: string; status: string; projected: boolean }
export interface LedgerPayment { id: string; date: string; amount: string; charges: string; interest: string; principal: string; principalAfter: string; interestAfter: string; chargesAfter: string; totalAfter: string; nextPeriodInterest: string }
export interface LedgerSummary {
  asOf: string; periodRate: string; termPeriods: number; principal: string; principalOpen: string; interestPending: string; chargesPending: string; balance: string;
  interestAccrued: string; interestCapitalized: string; chargesAccrued: string; totalPaid: string; principalPaid: string; interestPaid: string; chargesPaid: string;
  overdueAmount: string; daysLate: number; futureInterest: string; totalToReceive: string; nextDue: { date: string; amount: string; number: number } | null;
  nextPeriodInterest: string; status: 'ON_TIME' | 'DUE_TODAY' | 'DUE_THIS_WEEK' | 'OVERDUE' | 'PAID'; progress: number;
}
export interface Ledger extends LedgerSummary { payments: LedgerPayment[]; periods: LedgerPeriod[] }
export interface BalanceLoanCard {
  id: string; number: number; status: string; engine: string; billingType: string; periodRate: string; periodicity: string; startDate: string; maturityDate: string;
  client: { id: string; name: string; document: string; phone: string | null }; summary: LedgerSummary;
}
export interface HistoryItem extends LedgerPayment { method: string; notes: string | null; receiptNumber: number | null; receivedByName: string | null; createdAt: string }
export interface BalanceLoan {
  id: string; number: number; status: string; engine: string; clientId: string; client: Client; billingType: string; periodRate: string; periodicity: string;
  principalAmount: string; disbursementDate: string; maturityDate: string; pendingInterestMode: 'SEPARATE' | 'CAPITALIZE'; disbursementMethod: string | null;
  lateFineRate: string; lateInterestMonthly: string; notes: string | null; calcExplanation: string | null; createdAt: string;
  contracts: Contract[]; events: LoanEvent[]; history: HistoryItem[]; ledger: Ledger; today: string;
}
export interface Allocation { amount: string; charges: string; interest: string; principal: string; principalAfter: string; interestAfter: string; chargesAfter: string; totalAfter: string; nextPeriodInterest: string; paysOff: boolean }
export interface PaymentPreview { before: { balance: string; principalOpen: string; interestPending: string; chargesPending: string }; allocation: Allocation; summaryAfter: Ledger }
export interface DueItem { loanId: string; number: number; clientId: string; clientName: string; clientPhone: string | null; dueDate: string; amount: string; daysLate: number; kind: 'BALANCE' | 'INSTALLMENT' }
export interface LendingDashboard {
  today: string;
  totals: { lent: string; received: string; interestReceived: string; interestToReceive: string; outstanding: string; receivedMonth: string; overdueAmount: string; overdueClients: number };
  statusCount: Record<string, number>; dueToday: DueItem[]; dueWeek: DueItem[]; overdue: DueItem[];
}
export interface CreditorSettings { name?: string; nationality?: string; maritalStatus?: string; profession?: string; cpf?: string; rg?: string; address?: string; city?: string; state?: string; phone?: string; pixKey?: string }
export interface LendingSettings { pendingInterestMode: 'SEPARATE' | 'CAPITALIZE'; lateFineRate: string; lateInterestMonthly: string; accelerationDays: number; quitationDays: number; forumCity: string }
export interface BalanceSimulation { termPeriods: number; principal: string; totalInterest: string; totalToReceive: string; firstInstallment: string; monthlyEquivalent: string; periods: Array<{ number: number; dueDate: string; openingPrincipal: string; interest: string; principalDue: string; amountDue: string }> }
