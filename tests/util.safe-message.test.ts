import { describe, expect, it } from 'vitest';
import { safeMessage } from '../src/util/safe-message.js';

describe('safeMessage', () => {
  it('returns message from Error instances', () => {
    expect(safeMessage(new Error('boom'))).toBe('boom');
  });

  it('returns message from Error subclasses', () => {
    class CustomError extends Error {
      constructor() {
        super('custom');
        this.name = 'CustomError';
      }
    }
    expect(safeMessage(new CustomError())).toBe('custom');
  });

  it('stringifies plain strings', () => {
    expect(safeMessage('plain')).toBe('plain');
  });

  it('stringifies numbers and booleans', () => {
    expect(safeMessage(42)).toBe('42');
    expect(safeMessage(false)).toBe('false');
  });

  it('stringifies null and undefined', () => {
    expect(safeMessage(null)).toBe('null');
    expect(safeMessage(undefined)).toBe('undefined');
  });

  it('does not throw on an object without a string conversion', () => {
    // Object.create(null) has no Object.prototype, no toString — String() throws.
    const poison: unknown = Object.create(null) as unknown;
    expect(() => safeMessage(poison)).not.toThrow();
    expect(typeof safeMessage(poison)).toBe('string');
  });

  it('does not throw on an object whose Symbol.toPrimitive returns an object', () => {
    const poison = {
      [Symbol.toPrimitive]: () => ({}) as unknown as string,
    };
    expect(() => safeMessage(poison)).not.toThrow();
    expect(typeof safeMessage(poison)).toBe('string');
  });
});
