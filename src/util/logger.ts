import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeMessage } from './safe-message.js';

export type LogLevel = 'info' | 'warn' | 'error';

let fileStream: WriteStream | null = null;
let stderrEnabled = false;

export async function setLogFile(path: string | null): Promise<void> {
  if (fileStream !== null) {
    const old = fileStream;
    fileStream = null;
    await new Promise<void>((resolve) => old.end(() => resolve()));
  }
  if (path === null) return;
  await mkdir(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: 'a' });
  stream.on('error', (err: unknown) => {
    fileStream = null;
    process.stderr.write(`[logger] file logging disabled: ${safeMessage(err)}\n`);
  });
  fileStream = stream;
}

export function setStderrEnabled(flag: boolean): void {
  stderrEnabled = flag;
}

function formatFields(fields: Record<string, unknown> | undefined): string {
  if (fields === undefined) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const rendered = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${rendered}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function emit(text: string): void {
  if (fileStream !== null) fileStream.write(text);
  if (stderrEnabled) process.stderr.write(text);
}

export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  emit(`${ts} [${level}] ${message}${formatFields(fields)}\n`);
}

/**
 * Log a header line followed by a verbatim multi-line body (e.g. an email
 * body). The body is bracketed with a separator so it stays scannable when
 * tailing the file.
 */
export function logBlock(
  level: LogLevel,
  header: string,
  body: string,
  fields?: Record<string, unknown>
): void {
  const ts = new Date().toISOString();
  const sep = '─'.repeat(60);
  emit(`${ts} [${level}] ${header}${formatFields(fields)}\n${sep}\n${body}\n${sep}\n`);
}

export async function closeLogger(): Promise<void> {
  if (fileStream === null) return;
  const old = fileStream;
  fileStream = null;
  await new Promise<void>((resolve) => old.end(() => resolve()));
}
