// Serialize only operations sharing a business key; failures do not poison the queue.
export class SerialWork {
  private work = new Map<string, Promise<unknown>>();
  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const next = (this.work.get(key) || Promise.resolve()).catch(() => {}).then(action);
    this.work.set(key, next);
    void next.finally(() => { if (this.work.get(key) === next) this.work.delete(key); }).catch(() => {});
    return next;
  }
  async drain() { await Promise.allSettled([...this.work.values()]); }
}

export async function forEachConcurrent<T>(items: Iterable<T>, limit: number, action: (item: T) => Promise<void>) {
  const remaining = [...items];
  const worker = async () => {
    while (remaining.length) await action(remaining.shift()!);
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(limit, remaining.length) }, worker));
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
