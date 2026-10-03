// Fixed-memory latency histogram (log buckets, ~1.5% relative error) and time-weighted gauges.

const MIN = 0.001; // ms
const FACTOR = 1.03;
const LOG_F = Math.log(FACTOR);
export const HIST_BINS = Math.ceil(Math.log(3_600_000 / MIN) / LOG_F) + 2;

function binOf(v: number): number {
  if (v <= MIN) return 0;
  const b = 1 + Math.floor(Math.log(v / MIN) / LOG_F);
  return b >= HIST_BINS ? HIST_BINS - 1 : b;
}

function valueOf(b: number): number {
  if (b === 0) return MIN;
  // geometric middle of the bin
  return MIN * Math.pow(FACTOR, b - 0.5);
}

export class Histogram {
  bins = new Uint32Array(HIST_BINS);
  count = 0;
  sum = 0;
  max = 0;

  add(v: number): void {
    this.bins[binOf(v)]++;
    this.count++;
    this.sum += v;
    if (v > this.max) this.max = v;
  }

  merge(o: Histogram): void {
    for (let i = 0; i < HIST_BINS; i++) this.bins[i] += o.bins[i];
    this.count += o.count;
    this.sum += o.sum;
    if (o.max > this.max) this.max = o.max;
  }

  quantile(q: number): number {
    if (this.count === 0) return NaN;
    const target = Math.max(1, Math.ceil(q * this.count));
    let acc = 0;
    for (let i = 0; i < HIST_BINS; i++) {
      acc += this.bins[i];
      if (acc >= target) return Math.min(valueOf(i), this.max);
    }
    return this.max;
  }

  mean(): number {
    return this.count ? this.sum / this.count : NaN;
  }
}

/** Integrates a piecewise-constant value over time so per-bucket averages are exact. */
export class Gauge {
  v = 0;
  private area = 0;
  private last = 0;
  private peak = 0;

  set(t: number, v: number): void {
    this.area += this.v * (t - this.last);
    this.last = t;
    this.v = v;
    if (v > this.peak) this.peak = v;
  }

  add(t: number, d: number): void {
    this.set(t, this.v + d);
  }

  /** Returns [average, max] since the last flush and starts a new bucket. */
  flush(t: number, span: number): [number, number] {
    this.area += this.v * (t - this.last);
    this.last = t;
    const avg = span > 0 ? this.area / span : this.v;
    const peak = this.peak;
    this.area = 0;
    this.peak = this.v;
    return [avg, peak];
  }
}
