import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { describeReason, installRejectionGuard } from '../src/process-guards.js';

// Owner, 2026-10-20: prod chat went down after the gateway crashed three times
// on an unhandled rejection of a plain Directus error object.
describe('the unhandled-rejection guard', () => {
  it('logs the rejection in full and does not exit', () => {
    const proc = new EventEmitter();
    const error = vi.fn();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installRejectionGuard({ error }, proc as never);
    proc.emit('unhandledRejection', { errors: [{ message: 'Service unavailable' }] });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls[0]![0])).toContain('Service unavailable');
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('never prints a plain object as "#<Object>"', () => {
    expect(describeReason({ a: 1 })).toEqual({ value: { a: 1 } });
    expect(describeReason(new Error('boom')).message).toBe('boom');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof describeReason(circular).value).toBe('string');
  });
});
