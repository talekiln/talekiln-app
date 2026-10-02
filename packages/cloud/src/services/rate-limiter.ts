import { ServiceError } from './errors';

/** 内存滑动窗口限流（单实例；多实例部署需换成共享存储）。 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;
  /** 见过的最大窗口：清扫只能按它来，否则短窗口的调用会把别的键里长窗口的记录清掉（如 1 分钟与 1 小时并用）。 */
  private maxWindow = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** 记一次请求；超过 limit 次/windowMs 则抛 rate_limited。 */
  hit(key: string, limit: number, windowMs: number): void {
    const t = this.now();
    this.maxWindow = Math.max(this.maxWindow, windowMs);
    this.sweep(t, this.maxWindow);
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      throw new ServiceError('rate_limited', 'too many requests');
    }
    arr.push(t);
    this.hits.set(key, arr);
  }

  private sweep(t: number, windowMs: number) {
    if (t - this.lastSweep < windowMs) return;
    this.lastSweep = t;
    for (const [k, v] of this.hits) if (!v.some((x) => t - x < windowMs)) this.hits.delete(k);
  }
}
