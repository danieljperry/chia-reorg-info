import { vi } from 'vitest';

// Shared factory for the chia-agent RPC functions imported anywhere in src/.
// Each test file calls this once and feeds the result to
//   vi.mock('chia-agent/api/rpc/full_node/index.js', () => mocks).
// Tests that don't exercise a given function still get a defined vi.fn() so
// transitive imports (e.g. via createServer) don't blow up on undefined access.
export type ChiaAgentMocks = {
  get_blockchain_state: ReturnType<typeof vi.fn>;
  get_block_record_by_height: ReturnType<typeof vi.fn>;
  get_block_record: ReturnType<typeof vi.fn>;
  get_block_records: ReturnType<typeof vi.fn>;
  get_block_spends: ReturnType<typeof vi.fn>;
  get_additions_and_removals: ReturnType<typeof vi.fn>;
  get_coin_records_by_puzzle_hash: ReturnType<typeof vi.fn>;
  get_coin_record_by_name: ReturnType<typeof vi.fn>;
};

export function createChiaAgentMocks(): ChiaAgentMocks {
  return {
    get_blockchain_state: vi.fn(),
    get_block_record_by_height: vi.fn(),
    get_block_record: vi.fn(),
    get_block_records: vi.fn(),
    get_block_spends: vi.fn(),
    get_additions_and_removals: vi.fn(),
    get_coin_records_by_puzzle_hash: vi.fn(),
    get_coin_record_by_name: vi.fn(),
  };
}
