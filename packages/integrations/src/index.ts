/**
 * @rentwell/integrations
 *
 * Everything that talks to something outside the application: payment-file
 * parsing, the banking provider contract and its simulator, and private object
 * storage. Adapters normalise to the shapes in `provider/types.ts`; no
 * provider-specific payload reaches the financial domain.
 */

export * from './csv/parser';
export * from './provider/types';
export * from './provider/simulator';
export * from './provider/registry';
export * from './storage/objectStore';
