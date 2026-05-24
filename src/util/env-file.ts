import { readFile } from 'node:fs/promises';

export type EnvFileResult = {
  loaded: string[]; // keys newly set from the file
  skipped: string[]; // keys that were already set in process.env and left alone
};

/**
 * Parse a simple dotenv-style file (KEY=VALUE per line, `#` for comments,
 * optional matching quotes around the value) and apply it to process.env.
 *
 * Does NOT overwrite variables already set in the environment — shell exports
 * win, so the user can override file values without editing the file.
 */
export async function loadEnvFile(path: string): Promise<EnvFileResult> {
  const raw = await readFile(path, 'utf8');
  const loaded: string[] = [];
  const skipped: string[] = [];

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i] ?? '';
    const trimmed = original.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Accept optional `export ` prefix so shell-style env files work too.
    const working = trimmed.replace(/^export\s+/, '');

    const eq = working.indexOf('=');
    if (eq <= 0) {
      throw new Error(`${path}:${i + 1}: expected KEY=VALUE, got "${original}"`);
    }

    const key = working.slice(0, eq).trim();
    let value = working.slice(eq + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${path}:${i + 1}: invalid env var name "${key}"`);
    }

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    const existing = process.env[key];
    if (existing !== undefined && existing !== '') {
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    loaded.push(key);
  }

  return { loaded, skipped };
}
