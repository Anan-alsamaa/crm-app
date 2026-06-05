/**
 * Zero-dependency Prometheus metrics (text exposition format 0.0.4).
 *
 * We deliberately avoid pulling `prom-client` into the dependency tree — the
 * exposition format is just text, and the three Node services only need
 * counters, gauges and histograms plus a handful of default process metrics.
 *
 * Usage:
 *   const reg = new Registry();
 *   const reqs = reg.counter('http_requests_total', 'HTTP requests', ['method', 'route', 'status']);
 *   reqs.inc({ method: 'GET', route: '/foo', status: '200' });
 *   app.get('/metrics', async (_req, reply) => {
 *     reply.header('content-type', reg.contentType);
 *     return reg.render();
 *   });
 */

export type Labels = Record<string, string | number>;

const escapeLabelValue = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const seriesKey = (labels?: Labels): string => {
  if (!labels) return '';
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabelValue(String(labels[k]))}"`)
    .join(',');
};

const withLabels = (name: string, key: string, extra?: string): string => {
  const parts = [key, extra].filter(Boolean).join(',');
  return parts ? `${name}{${parts}}` : name;
};

interface Metric {
  render(): string[];
}

export class Counter implements Metric {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    private readonly help: string,
  ) {}
  inc(labels?: Labels, by = 1): void {
    const k = seriesKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${withLabels(this.name, k)} ${v}`);
    return lines;
  }
}

export class Gauge implements Metric {
  private readonly values = new Map<string, number>();
  /** Optional collector invoked at render time (e.g. live queue depth). */
  private collector?: () => void;
  constructor(
    readonly name: string,
    private readonly help: string,
  ) {}
  set(value: number, labels?: Labels): void {
    this.values.set(seriesKey(labels), value);
  }
  inc(by = 1, labels?: Labels): void {
    const k = seriesKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  dec(by = 1, labels?: Labels): void {
    this.inc(-by, labels);
  }
  onCollect(fn: () => void): this {
    this.collector = fn;
    return this;
  }
  render(): string[] {
    this.collector?.();
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [k, v] of this.values) lines.push(`${withLabels(this.name, k)} ${v}`);
    return lines;
  }
}

export class Histogram implements Metric {
  private readonly buckets: number[];
  private readonly counts = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  constructor(
    readonly name: string,
    private readonly help: string,
    buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }
  observe(value: number, labels?: Labels): void {
    const k = seriesKey(labels);
    let bucketCounts = this.counts.get(k);
    if (!bucketCounts) {
      bucketCounts = new Array<number>(this.buckets.length).fill(0);
      this.counts.set(k, bucketCounts);
    }
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]!) bucketCounts[i]! += 1;
    }
    this.sums.set(k, (this.sums.get(k) ?? 0) + value);
    this.totals.set(k, (this.totals.get(k) ?? 0) + 1);
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, bucketCounts] of this.counts) {
      // bucketCounts[i] already holds the cumulative count of observations
      // <= buckets[i] (observe() increments every bucket the value falls under),
      // so they are emitted directly — no second accumulation pass.
      for (let i = 0; i < this.buckets.length; i += 1) {
        lines.push(
          `${withLabels(this.name + '_bucket', k, `le="${this.buckets[i]}"`)} ${bucketCounts[i]}`,
        );
      }
      const total = this.totals.get(k) ?? 0;
      lines.push(`${withLabels(this.name + '_bucket', k, 'le="+Inf"')} ${total}`);
      lines.push(`${withLabels(this.name + '_sum', k)} ${this.sums.get(k) ?? 0}`);
      lines.push(`${withLabels(this.name + '_count', k)} ${total}`);
    }
    return lines;
  }
}

export class Registry {
  readonly contentType = 'text/plain; version=0.0.4; charset=utf-8';
  private readonly metrics: Metric[] = [];

  counter(name: string, help: string): Counter {
    const m = new Counter(name, help);
    this.metrics.push(m);
    return m;
  }
  gauge(name: string, help: string): Gauge {
    const m = new Gauge(name, help);
    this.metrics.push(m);
    return m;
  }
  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const m = new Histogram(name, help, buckets);
    this.metrics.push(m);
    return m;
  }

  /** Register default process gauges (memory + uptime), refreshed at scrape. */
  collectDefaultMetrics(serviceName: string): void {
    const labels = { service: serviceName };
    const rss = this.gauge('process_resident_memory_bytes', 'Resident memory size in bytes.');
    rss.onCollect(() => rss.set(process.memoryUsage().rss, labels));
    const heap = this.gauge('nodejs_heap_used_bytes', 'Process heap used in bytes.');
    heap.onCollect(() => heap.set(process.memoryUsage().heapUsed, labels));
    const uptime = this.gauge('process_uptime_seconds', 'Process uptime in seconds.');
    uptime.onCollect(() => uptime.set(process.uptime(), labels));
  }

  render(): string {
    return this.metrics.flatMap((m) => m.render()).join('\n') + '\n';
  }
}
