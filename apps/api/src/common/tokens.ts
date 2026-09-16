/**
 * Injection tokens for values that are not classes.
 *
 * Nest can only inject a class by its constructor. Configuration, the logger
 * and the object store are plain values, so they get explicit tokens rather
 * than being reached through a module-level singleton, which would make them
 * impossible to replace in a test.
 */

export const LOGGER = Symbol('LOGGER');
export const OBJECT_STORE = Symbol('OBJECT_STORE');
export const BANKING_PROVIDER = Symbol('BANKING_PROVIDER');
export const QUEUE_CLIENT = Symbol('QUEUE_CLIENT');
export const ASSISTANT_PROVIDER = Symbol('ASSISTANT_PROVIDER');
export const CLOCK = Symbol('CLOCK');
