export interface Item {
  id: string
  title: string
}

export type ItemStatus = 'new' | 'done'

export enum Priority {
  Low = 1,
  High = 2,
}

export class Repository {
  private items: Item[] = []

  add(item: Item): void {
    this.items.push(item)
  }

  count(): number {
    return this.items.length
  }
}

export function summarizeAll(items: Item[]): string {
  return `${items.length} items`
}
