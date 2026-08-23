export class ExecutorOverloadedError extends Error {
  constructor() {
    super('bounded executor overloaded')
    this.name = 'ExecutorOverloadedError'
  }
}

interface ExecutorOptions {
  maxConcurrent: number;
  maxPending: number;
}

interface PendingTask {
  start: () => void;
}

export class BoundedExecutor {
  private active = 0;
  private pending: PendingTask[] = [];

  constructor(private readonly options: ExecutorOptions) {
    if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be a positive integer')
    }
    if (!Number.isSafeInteger(options.maxPending) || options.maxPending < 0) {
      throw new RangeError('maxPending must be a non-negative integer')
    }
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    void key // P0 intentionally uses one global FIFO; P1 partitions by daemon.
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++
        let result: Promise<T>
        try {
          result = task()
        } catch (error) {
          result = Promise.reject(error)
        }
        Promise.resolve(result)
          .then(resolve, reject)
          .finally(() => {
            this.active--
            this.pending.shift()?.start()
          })
      }
      if (this.active < this.options.maxConcurrent) {
        start()
        return
      }
      if (this.pending.length >= this.options.maxPending) {
        reject(new ExecutorOverloadedError())
        return
      }
      this.pending.push({ start })
    })
  }
}
