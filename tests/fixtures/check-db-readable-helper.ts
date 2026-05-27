// Standalone helper used by tests/cli.reorg-monitor.db-path-check.test.ts to
// exercise checkDbPathReadable's "not readable" branch from a subprocess
// running as a different uid. The parent test runner spawns this with
// `uid: 65534` (nobody) when the test process itself is root and can
// therefore bypass file-mode restrictions.
//
// Output format: stdout is either the literal string `__NULL__` (when
// checkDbPathReadable returns null, meaning the file is readable) or the
// reason string. No trailing newline.

import { checkDbPathReadable } from '../../src/cli/reorg-monitor.js';

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write('usage: check-db-readable-helper.ts <path>\n');
  process.exit(2);
}

const result = checkDbPathReadable(path);
process.stdout.write(result === null ? '__NULL__' : result);
