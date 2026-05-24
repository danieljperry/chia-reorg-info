import { RPCAgent } from 'chia-agent';
import { COINSET_HOST, Network } from '../network.js';

const cache = new Map<Network, RPCAgent>();

export function getAgent(network: Network): RPCAgent {
  let agent = cache.get(network);
  if (!agent) {
    agent = new RPCAgent({
      protocol: 'https',
      host: COINSET_HOST[network],
      port: 443,
      keepAlive: true,
      timeout: 30_000,
    });
    cache.set(network, agent);
  }
  return agent;
}

/** Test-only hook to inject a stub agent. */
export function setAgent(network: Network, agent: RPCAgent): void {
  cache.set(network, agent);
}

/** Test-only hook to clear cached agents. */
export function resetAgents(): void {
  cache.clear();
}
