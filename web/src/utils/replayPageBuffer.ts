export class ReplayPageBuffer<T> {
  private items: T[] = []

  append(batch: T[]) {
    this.items.push(...batch)
  }

  reset() {
    this.items = []
  }

  take(): T[] {
    const result = this.items
    this.items = []
    return result
  }
}
