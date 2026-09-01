import { Repository, summarizeAll, type Item } from '../core/model.js'

export function renderApp(items: Item[]): string {
  const repository = new Repository()
  for (const item of items) {
    repository.add(item)
  }
  return `<ul>${summarizeAll(items)} ${repository.count()}</ul>`
}
