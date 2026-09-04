import chalk from 'chalk'
import { Priority } from './model.js'
import { formatLabel, parsePriority } from '../utils/format.js'
import { slugify } from '../utils/slug.js'

export interface ServiceOptions {
  verbose: boolean
}

export function buildLabel(item: { title: string; status: string }): string {
  return formatLabel(item.title, item.status)
}

export function resolvePriority(raw: string): Priority {
  return parsePriority(raw)
}

export function serviceSlug(title: string): string {
  return slugify(title)
}

export function banner(text: string): string {
  return chalk.bold(text)
}
