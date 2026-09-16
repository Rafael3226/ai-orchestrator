/** Keyed in-process mutex — serializes `git worktree add` per repository. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => {
      release = r;
    });
    this.tails.set(
      key,
      previous.then(() => current),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}
