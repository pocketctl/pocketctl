import {
  createUserWithWelcomeEmail,
  getUserByEmail,
  type User,
} from './db.js'
import type { SupportedLanguage } from './config/language.js'

export async function findOrCreateEmailUser(
  pool: any,
  email: string,
  displayName: string,
  locale: SupportedLanguage,
): Promise<User> {
  const normalizedEmail = email.trim().toLowerCase()
  const existing = await getUserByEmail(pool, normalizedEmail)
  if (existing) return existing

  try {
    return await createUserWithWelcomeEmail(pool, normalizedEmail, '', displayName, locale)
  } catch (error: any) {
    if (error?.code !== '23505') throw error
    const winner = await getUserByEmail(pool, normalizedEmail)
    if (winner) return winner
    throw error
  }
}
