/**
 * @rentwell/domain
 *
 * Pure financial logic with no I/O, no database client and no framework
 * dependency. Everything exported here is deterministic and unit-testable, so
 * the rules that decide money are provable without standing up a stack.
 */

export * from './errors';
export * from './types';
export * from './audit';

export * from './money/decimal';
export * from './money/money';

export * from './periods/dates';

export * from './charges/proration';
export * from './charges/generation';

export * from './allocation/allocation';

export * from './matching/normalize';
export * from './matching/engine';

export * from './ledger/accounts';
export * from './ledger/posting';

export * from './close/readiness';

export * from './access/permissions';

export * from './exceptions/rules';
