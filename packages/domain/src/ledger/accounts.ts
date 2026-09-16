/**
 * The receivables subledger chart of accounts.
 *
 * This is a limited subledger covering tenant receivables and the cash that
 * settles them. It is not a corporate general ledger: there is no bank
 * reconciliation account, no tax, no accrual reversal machinery, and no
 * statement of financial position. The five accounts below are exactly the ones
 * needed to keep receivables and unapplied cash provable.
 */

import {
  LedgerAccountCode,
  NormalBalance,
  type LedgerAccountCode as LedgerAccountCodeValue,
  type NormalBalance as NormalBalanceValue,
} from '../types';

export interface LedgerAccountDefinition {
  readonly code: LedgerAccountCodeValue;
  readonly name: string;
  readonly normalBalance: NormalBalanceValue;
  /** Included in outstanding receivables reporting. */
  readonly isReceivable: boolean;
  /** Included in unapplied cash reporting. */
  readonly isUnappliedCash: boolean;
  readonly description: string;
}

export const LEDGER_ACCOUNTS: readonly LedgerAccountDefinition[] = Object.freeze([
  {
    code: LedgerAccountCode.ACCOUNTS_RECEIVABLE,
    name: 'Accounts receivable',
    normalBalance: NormalBalance.DEBIT,
    isReceivable: true,
    isUnappliedCash: false,
    description: 'Amounts billed to tenants and not yet settled by payment or credit.',
  },
  {
    code: LedgerAccountCode.RENTAL_INCOME,
    name: 'Rental income',
    normalBalance: NormalBalance.CREDIT,
    isReceivable: false,
    isUnappliedCash: false,
    description: 'Base rent earned in the service period of the charge.',
  },
  {
    code: LedgerAccountCode.OPERATING_CHARGE_INCOME,
    name: 'Operating charge income',
    normalBalance: NormalBalance.CREDIT,
    isReceivable: false,
    isUnappliedCash: false,
    description: 'Recoverable operating charges and one-time fees billed to tenants.',
  },
  {
    code: LedgerAccountCode.CASH_CLEARING,
    name: 'Cash clearing',
    normalBalance: NormalBalance.DEBIT,
    isReceivable: false,
    isUnappliedCash: false,
    description:
      'Funds received into a property bank account. Debited on receipt; this subledger does not reconcile it to a bank statement balance.',
  },
  {
    code: LedgerAccountCode.UNAPPLIED_CASH,
    name: 'Unapplied cash',
    normalBalance: NormalBalance.CREDIT,
    isReceivable: false,
    isUnappliedCash: true,
    description:
      'Money received but not yet matched to a charge. A credit balance here is a liability to the tenant until it is allocated.',
  },
]);

const BY_CODE: ReadonlyMap<LedgerAccountCodeValue, LedgerAccountDefinition> = new Map(
  LEDGER_ACCOUNTS.map((account) => [account.code, account]),
);

export function ledgerAccount(code: LedgerAccountCodeValue): LedgerAccountDefinition {
  const account = BY_CODE.get(code);
  if (!account) throw new Error(`Unknown ledger account code: ${code}`);
  return account;
}

export function normalBalanceOf(code: LedgerAccountCodeValue): NormalBalanceValue {
  return ledgerAccount(code).normalBalance;
}

/**
 * Signed effect of a (debit, credit) pair on an account's own normal balance.
 * A debit increases a debit-normal account and decreases a credit-normal one.
 */
export function signedEffect(
  code: LedgerAccountCodeValue,
  debitCents: number,
  creditCents: number,
): number {
  return normalBalanceOf(code) === NormalBalance.DEBIT
    ? debitCents - creditCents
    : creditCents - debitCents;
}

/** The income account a charge type credits when posted. */
export function incomeAccountForChargeType(chargeType: string): LedgerAccountCodeValue {
  return chargeType === 'BASE_RENT'
    ? LedgerAccountCode.RENTAL_INCOME
    : LedgerAccountCode.OPERATING_CHARGE_INCOME;
}
