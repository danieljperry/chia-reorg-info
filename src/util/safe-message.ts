import { inspect } from 'node:util';

/**
 * Format an arbitrary thrown value as a string, never throwing.
 *
 * `String(err)` can itself throw with "Cannot convert object to primitive value"
 * when the rejected value is an object without a primitive coercion (e.g. an
 * Object.create(null), or a Proxy whose toString trap returns an object). When
 * that happens inside a catch block, the catch silently re-throws and crashes
 * the process. We've seen this from chia-agent / coinset RPC rejections.
 */
export function safeMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    try {
      return inspect(err, { depth: 1, breakLength: Infinity });
    } catch {
      return '<unprintable error>';
    }
  }
}
