import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { ReportJob } from '@yiji/shared-types';
import { processReportJob, type ReportsDeps, type ReportRow } from '../src/processors/reports.js';

/**
 * Exercises processReportJob across the four implemented aggregators, the
 * not-implemented fallback, the email-on-schedule branch, and the not-found
 * error — using a sequenced mock Directus client + a mock mail transport. No
 * live Directus / SMTP. Timestamps come from production `new Date()`; we never
 * assert their exact value, only their presence/shape.
 */

const silentLogger = {
  info: () => undefined,
  warn: vi.fn(),
  error: () => undefined,
  debug: () => undefined,
} as never;

function makeDeps(over: Partial<ReportsDeps> = {}): {
  deps: ReportsDeps;
  request: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const send = vi.fn(async () => undefined);
  const deps: ReportsDeps = {
    directus: { request } as never,
    mail: { send },
    logger: silentLogger,
    ...over,
  };
  return { deps, request, send };
}

function jobFor(reportId: string): Job<ReportJob> {
  return { data: { reportId } } as Job<ReportJob>;
}

function report(over: Partial<ReportRow>): ReportRow {
  return {
    id: 'r-1',
    name: 'Test Report',
    type: 'conversation_volume',
    filters: null,
    schedule: null,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('processReportJob', () => {
  it('throws when the report row is not found', async () => {
    const { deps, request } = makeDeps();
    request.mockResolvedValueOnce(null);
    await expect(processReportJob(jobFor('missing'), deps)).rejects.toThrow(/not found/);
  });

  it('conversation_volume buckets conversations by day', async () => {
    const { deps, request } = makeDeps();
    request
      .mockResolvedValueOnce(report({ type: 'conversation_volume' })) // readItem(report)
      .mockResolvedValueOnce([
        { id: '1', status: 'open', date_created: '2026-06-01T08:00:00Z', vendor: 'v' },
        { id: '2', status: 'closed', date_created: '2026-06-01T09:00:00Z', vendor: 'v' },
        { id: '3', status: 'open', date_created: '2026-06-02T10:00:00Z', vendor: 'v' },
      ]) // aggregator readItems
      .mockResolvedValueOnce(undefined); // updateItem last_run_at
    const res = await processReportJob(jobFor('r-1'), deps);
    expect(res.type).toBe('conversation_volume');
    expect(res.rowCount).toBe(2); // two distinct days
    expect(res.csv).toContain('"day","total","open"');
    expect(res.csv).toContain('"2026-06-01","2","1"');
    expect(typeof res.generatedAt).toBe('string');
  });

  it('response_time computes minutes and skips rows missing timestamps', async () => {
    const { deps, request } = makeDeps();
    request
      .mockResolvedValueOnce(report({ type: 'response_time' }))
      .mockResolvedValueOnce([
        {
          id: 't1',
          subject: 'A',
          priority: 'high',
          date_created: '2026-06-01T10:00:00Z',
          first_responded_at: '2026-06-01T10:30:00Z',
        },
        { id: 't2', subject: 'B', priority: 'low', date_created: null, first_responded_at: null },
      ])
      .mockResolvedValueOnce(undefined);
    const res = await processReportJob(jobFor('r-1'), deps);
    expect(res.rowCount).toBe(1);
    expect(res.csv).toContain('"t1","A","high","30"');
  });

  it('sla_compliance reports met / not-met / pending', async () => {
    const { deps, request } = makeDeps();
    request
      .mockResolvedValueOnce(report({ type: 'sla_compliance' }))
      .mockResolvedValueOnce([
        {
          id: 't1',
          subject: 'met',
          priority: 'high',
          first_response_due_at: '2026-06-01T11:00:00Z',
          first_responded_at: '2026-06-01T10:30:00Z',
          resolution_due_at: '2026-06-01T12:00:00Z',
          resolved_at: '2026-06-01T13:00:00Z',
        },
        {
          id: 't2',
          subject: 'pending',
          priority: 'low',
          first_response_due_at: null,
          first_responded_at: null,
          resolution_due_at: null,
          resolved_at: null,
        },
      ])
      .mockResolvedValueOnce(undefined);
    const res = await processReportJob(jobFor('r-1'), deps);
    expect(res.csv).toContain('"t1","met","high","yes","no"');
    expect(res.csv).toContain('"t2","pending","low","pending","pending"');
  });

  it('ticket_resolution computes resolution minutes', async () => {
    const { deps, request } = makeDeps();
    request
      .mockResolvedValueOnce(report({ type: 'ticket_resolution' }))
      .mockResolvedValueOnce([
        {
          id: 't1',
          subject: 'done',
          status: 'closed',
          priority: 'high',
          date_created: '2026-06-01T10:00:00Z',
          resolved_at: '2026-06-01T11:00:00Z',
        },
      ])
      .mockResolvedValueOnce(undefined);
    const res = await processReportJob(jobFor('r-1'), deps);
    expect(res.csv).toContain('"t1","done","closed","high","60"');
  });

  it('falls back to a "not implemented" CSV for unknown report types', async () => {
    const { deps, request } = makeDeps();
    request
      .mockResolvedValueOnce(report({ type: 'agent_performance' }))
      .mockResolvedValueOnce(undefined); // updateItem only (no aggregator read)
    const res = await processReportJob(jobFor('r-1'), deps);
    expect(res.csv).toContain('not yet implemented');
  });

  it('emails the report when the schedule lists recipients', async () => {
    const { deps, request, send } = makeDeps();
    request
      .mockResolvedValueOnce(
        report({ type: 'conversation_volume', schedule: { email: ['ops@x.com', 'qa@x.com'] } }),
      )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined);
    await processReportJob(jobFor('r-1'), deps);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@x.com, qa@x.com',
        subject: expect.stringContaining('Test Report'),
      }),
    );
  });

  it('swallows email failures (logs a warning, still resolves)', async () => {
    const { deps, request, send } = makeDeps();
    send.mockRejectedValueOnce(new Error('smtp down'));
    request
      .mockResolvedValueOnce(report({ schedule: { email: ['ops@x.com'] } }))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined);
    const res = await processReportJob(jobFor('r-1'), deps);
    expect(res.reportId).toBe('r-1');
    expect(silentLogger.warn).toHaveBeenCalled();
  });

  it('ignores a failed last_run_at update', async () => {
    const { deps, request } = makeDeps();
    request
      .mockResolvedValueOnce(report({ type: 'conversation_volume' }))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('patch failed'));
    await expect(processReportJob(jobFor('r-1'), deps)).resolves.toMatchObject({ reportId: 'r-1' });
  });
});
