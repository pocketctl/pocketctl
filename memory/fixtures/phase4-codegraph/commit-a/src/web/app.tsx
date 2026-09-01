import { Repository, summarize, type Item } from '../core/model.js'

export function renderApp(items: Item[]): string {
  const repository = new Repository()
  for (const item of items) {
    repository.add(item)
  }
  return `<ul>${summarize(items)} ${repository.count()}</ul>`
}
