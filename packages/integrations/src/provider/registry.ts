/**
 * Provider selection.
 *
 * `simulator` is the only adapter in the public repository. A real provider
 * would register here and satisfy the same `BankingProvider` interface; nothing
 * downstream of this file knows which one is in use.
 */

import { ProviderError, type BankingProvider } from './types';
import { SimulatedBankingProvider, type SimulatorConfig } from './simulator';

export type ProviderName = 'simulator';

export interface ProviderFactoryOptions {
  readonly name: string;
  readonly simulator?: SimulatorConfig;
}

export function createBankingProvider(options: ProviderFactoryOptions): BankingProvider {
  switch (options.name) {
    case 'simulator': {
      if (!options.simulator) {
        throw new ProviderError(
          'The simulator provider needs a seed, accounts and a transaction set',
          'simulator',
          false,
        );
      }
      return new SimulatedBankingProvider(options.simulator);
    }
    default:
      throw new ProviderError(
        `Unknown banking provider "${options.name}". This build ships only the simulator.`,
        options.name,
        false,
      );
  }
}

export function isSupportedProvider(name: string): name is ProviderName {
  return name === 'simulator';
}
