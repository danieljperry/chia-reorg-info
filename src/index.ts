#!/usr/bin/env node
const [, , subcommand, ...rest] = process.argv;

const USAGE = `Usage: chia-reorg-info <subcommand> [options]

Subcommands:
  reorg_monitor              Long-running poller that detects Chia re-orgs and
                             optionally sends email alerts.
  check_block_canonical      One-shot: is the block at <height> still on the
                             canonical chain?
  scan_chain_consistency     One-shot: scan a height range for structural
                             evidence of past re-orgs.
  status                     Print the most recent monitor status line from
                             the log file.

Use \`chia-reorg-info <subcommand> --help\` for per-subcommand flags.
`;

if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
  process.stdout.write(USAGE);
  process.exit(0);
}

async function dispatch(): Promise<number> {
  switch (subcommand) {
    case 'reorg_monitor': {
      const { runReorgMonitorCli } = await import('./cli/reorg-monitor.js');
      return runReorgMonitorCli(rest);
    }
    case 'check_block_canonical': {
      const { runCheckBlockCanonicalCli } = await import('./cli/check-block-canonical.js');
      return runCheckBlockCanonicalCli(rest);
    }
    case 'scan_chain_consistency': {
      const { runScanChainConsistencyCli } = await import('./cli/scan-chain-consistency.js');
      return runScanChainConsistencyCli(rest);
    }
    case 'status': {
      const { runStatusCli } = await import('./cli/status.js');
      return runStatusCli(rest);
    }
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

process.exit(await dispatch());
