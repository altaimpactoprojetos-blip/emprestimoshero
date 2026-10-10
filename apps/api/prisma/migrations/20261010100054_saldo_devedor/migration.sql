-- CreateEnum
CREATE TYPE "LoanEngine" AS ENUM ('SCHEDULE', 'BALANCE');

-- CreateEnum
CREATE TYPE "BillingType" AS ENUM ('INTEREST_ONLY', 'FIXED_INSTALLMENTS', 'SINGLE_PAYMENT');

-- CreateEnum
CREATE TYPE "PendingInterestMode" AS ENUM ('SEPARATE', 'CAPITALIZE');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "maritalStatus" TEXT,
ADD COLUMN     "nationality" TEXT,
ADD COLUMN     "profession" TEXT,
ADD COLUMN     "rg" TEXT;

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "billingType" "BillingType",
ADD COLUMN     "disbursementMethod" TEXT,
ADD COLUMN     "engine" "LoanEngine" NOT NULL DEFAULT 'SCHEDULE',
ADD COLUMN     "maturityDate" DATE,
ADD COLUMN     "pendingInterestMode" "PendingInterestMode" NOT NULL DEFAULT 'SEPARATE',
ADD COLUMN     "periodRate" DECIMAL(10,6);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "balanceAfter" DECIMAL(14,2),
ALTER COLUMN "installmentId" DROP NOT NULL;
