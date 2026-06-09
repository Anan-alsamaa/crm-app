import { describe, it, expect } from 'vitest';
import { Registry } from '../src/metrics.js';

describe('Registry (zero-dep Prometheus exposition)', () => {
  it('renders a counter with labels and HELP/TYPE headers', () => {
    const reg = new Registry();
    const c = reg.counter('http_requests_total', 'HTTP requests handled.');
    c.inc({ method: 'GET', status: '200' });
    c.inc({ method: 'GET', status: '200' });
    c.inc({ method: 'POST', status: '500' });

    const out = reg.render();
    expect(out).toContain('# HELP http_requests_total HTTP requests handled.');
    expect(out).toContain('# TYPE http_requests_total counter');
    expect(out).toContain('http_requests_total{method="GET",status="200"} 2');
    expect(out).toContain('http_requests_total{method="POST",status="500"} 1');
  });

  it('sorts label keys deterministically regardless of insertion order', () => {
    const reg = new Registry();
    const c = reg.counter('x_total', 'x');
    c.inc({ z: '1', a: '2', m: '3' });
    expect(reg.render()).toContain('x_total{a="2",m="3",z="1"} 1');
  });

  it('escapes quotes and backslashes in label values', () => {
    const reg = new Registry();
    reg.counter('x_total', 'x').inc({ route: 'a"b\\c' });
    expect(reg.render()).toContain('route="a\\"b\\\\c"');
  });

  it('supports gauge set/inc/dec and onCollect', () => {
    const reg = new Registry();
    const g = reg.gauge('q_depth', 'depth');
    g.set(5, { queue: 'sla' });
    g.inc(2, { queue: 'sla' });
    g.dec(1, { queue: 'sla' });
    let collected = false;
    const live = reg.gauge('live', 'live');
    live.onCollect(() => {
      collected = true;
      live.set(42);
    });
    const out = reg.render();
    expect(out).toContain('q_depth{queue="sla"} 6');
    expect(collected).toBe(true);
    expect(out).toContain('live 42');
  });

  it('renders histogram cumulative buckets, _sum and _count', () => {
    const reg = new Registry();
    const h = reg.histogram('lat_seconds', 'latency', [0.1, 0.5, 1]);
    h.observe(0.05);
    h.observe(0.2);
    h.observe(2);

    const out = reg.render();
    // 0.05 only -> le=0.1 has 1; 0.2 adds to le=0.5; everything <= +Inf
    expect(out).toContain('lat_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('lat_seconds_bucket{le="0.5"} 2');
    expect(out).toContain('lat_seconds_bucket{le="1"} 2');
    expect(out).toContain('lat_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain('lat_seconds_count 3');
    expect(out).toContain('lat_seconds_sum 2.25');
  });

  it('default process metrics expose memory + uptime gauges', () => {
    const reg = new Registry();
    reg.collectDefaultMetrics('test-svc');
    const out = reg.render();
    expect(out).toContain('# TYPE process_resident_memory_bytes gauge');
    expect(out).toContain('process_uptime_seconds');
    expect(out).toContain('service="test-svc"');
  });
});
