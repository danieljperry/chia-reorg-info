export type Network = 'mainnet' | 'testnet11';

export const NETWORKS: readonly Network[] = ['mainnet', 'testnet11'] as const;

export const DEFAULT_NETWORK: Network = 'mainnet';

export const COINSET_HOST: Record<Network, string> = {
  mainnet: 'api.coinset.org',
  testnet11: 'api-testnet11.coinset.org',
};

export const ADDRESS_PREFIX: Record<Network, string> = {
  mainnet: 'xch',
  testnet11: 'txch',
};

export function networkFromPrefix(hrp: string): Network | null {
  if (hrp === 'xch') return 'mainnet';
  if (hrp === 'txch') return 'testnet11';
  return null;
}
