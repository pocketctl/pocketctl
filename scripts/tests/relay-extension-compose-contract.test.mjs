#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const extensionNames = [
  'RELAY_EXTENSIONS',
  'RELAY_EXTENSION_PROJECTOR_BATCH',
  'RELAY_EXTENSION_FEED_RETENTION_DAYS',
  'RELAY_EXTENSION_LEASE_TTL_SECONDS',
  'EXTENSION_PROVIDER_JWT_SECRET',
  'EXTENSION_PROVIDER_JWT_SECRET_B64',
  'EXTENSION_CURSOR_SECRET',
  'EXTENSION_CURSOR_SECRET_B64',
  'EXTENSION_GRANT_PRIVATE_KEY',
  'EXTENSION_GRANT_PRIVATE_KEY_B64',
  'EXTENSION_GRANT_PUBLIC_KEY',
  'EXTENSION_GRANT_PUBLIC_KEY_B64',
  'EXTENSION_GRANT_KEY_ID',
  'RELAY_EXTENSION_RATE_LIMIT_TOKEN',
  'RELAY_EXTENSION_RATE_LIMIT_FEED',
  'RELAY_EXTENSION_RATE_LIMIT_ACK',
  'RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT',
  'RELAY_EXTENSION_RATE_LIMIT_STATUS',
  'RELAY_EXTENSION_RATE_LIMIT_USAGE',
  'RELAY_EXTENSION_RATE_LIMIT_PURGE',
  'RELAY_EXTENSION_RATE_LIMIT_GRANT',
  'RELAY_EXTENSION_RATE_LIMIT_INSTALLATIONS',
]

function cleanEnvironment() {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.startsWith('MEMORY_') || extensionNames.includes(name)) delete env[name]
  }
  return env
}

function renderCompose(file, overrides = {}) {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', '/dev/null', '-f', file, 'config', '--format', 'json'],
    {
      cwd: repoRoot,
      env: { ...cleanEnvironment(), ...overrides },
      encoding: 'utf8',
    },
  )
  if (result.status !== 0) {
    throw new Error(`docker compose config failed for ${file}: ${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout)
}

function renderComposeFailure(file, overrides = {}) {
  return spawnSync(
    'docker',
    ['compose', '--env-file', '/dev/null', '-f', file, 'config', '--format', 'json'],
    {
      cwd: repoRoot,
      env: { ...cleanEnvironment(), ...overrides },
      encoding: 'utf8',
    },
  )
}

function assertEnvironment(service, expected) {
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(service.environment[name], value, `${name} was not delivered to ${service.image}`)
  }
}

const localDefaults = renderCompose('docker-compose.yml')
assert.equal(localDefaults.services.relay.environment.RELAY_EXTENSIONS, 'off')
assert.equal(localDefaults.services['relay-worker'].environment.RELAY_EXTENSIONS, 'off')

const extensionOverrides = {
  RELAY_EXTENSIONS: 'enabled',
  RELAY_EXTENSION_PROJECTOR_BATCH: '321',
  RELAY_EXTENSION_FEED_RETENTION_DAYS: '11',
  RELAY_EXTENSION_LEASE_TTL_SECONDS: '73',
  EXTENSION_PROVIDER_JWT_SECRET_B64: 'cHJvdmlkZXItc2VjcmV0LWZvci1jb21wb3NlLWNvbnRyYWN0',
  EXTENSION_CURSOR_SECRET_B64: 'Y3Vyc29yLXNlY3JldC1mb3ItY29tcG9zZS1jb250cmFjdA==',
  EXTENSION_GRANT_PRIVATE_KEY_B64: 'cHJpdmF0ZS1rZXk=',
  EXTENSION_GRANT_PUBLIC_KEY_B64: 'cHVibGljLWtleQ==',
  EXTENSION_GRANT_KEY_ID: 'compose-contract-kid',
  RELAY_EXTENSION_RATE_LIMIT_TOKEN: '31',
  RELAY_EXTENSION_RATE_LIMIT_FEED: '121',
  RELAY_EXTENSION_RATE_LIMIT_ACK: '241',
  RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT: '61',
  RELAY_EXTENSION_RATE_LIMIT_STATUS: '122',
  RELAY_EXTENSION_RATE_LIMIT_USAGE: '62',
  RELAY_EXTENSION_RATE_LIMIT_PURGE: '63',
  RELAY_EXTENSION_RATE_LIMIT_GRANT: '64',
  RELAY_EXTENSION_RATE_LIMIT_INSTALLATIONS: '65',
}

const localEnabled = renderCompose('docker-compose.yml', extensionOverrides)
assertEnvironment(localEnabled.services.relay, extensionOverrides)
assertEnvironment(localEnabled.services['relay-worker'], extensionOverrides)

const productionBase = {
  POSTGRES_ADMIN_PASSWORD: 'compose-admin-password',
  POSTGRES_APP_PASSWORD: 'compose-app-password',
  AUTH_CODE_PEPPER: 'compose-auth-code-pepper-0123456789',
  JWT_SECRET: 'compose-jwt-secret-012345678901234',
  TLS_CERT_PATH: '/tmp/compose-contract-cert.pem',
  TLS_KEY_PATH: '/tmp/compose-contract-key.pem',
  MEMORY_MODE: 'off',
  MEMORY_POSTGRES_PASSWORD: 'compose-memory-postgres-password',
  MEMORY_RELAY_URL: 'http://relay:8080',
  MEMORY_RELAY_ISSUER: 'http://relay:8080',
  MEMORY_PROVIDER_CLIENT_ID: 'compose-memory-client',
  MEMORY_PROVIDER_CLIENT_SECRET: 'compose-memory-client-secret',
  MEMORY_HMAC_KEY: 'compose-memory-hmac-key-012345678901',
}

const missingMode = renderComposeFailure('docker-compose.prod.yml', productionBase)
assert.notEqual(missingMode.status, 0, 'production compose accepted a missing RELAY_EXTENSIONS mode')
assert.match(missingMode.stderr, /RELAY_EXTENSIONS is required/)

const productionOff = renderCompose('docker-compose.prod.yml', {
  ...productionBase,
  RELAY_EXTENSIONS: 'off',
})
assert.equal(productionOff.services.relay.environment.RELAY_EXTENSIONS, 'off')
assert.equal(productionOff.services['relay-worker'].environment.RELAY_EXTENSIONS, 'off')

const productionEnabled = renderCompose('docker-compose.prod.yml', {
  ...productionBase,
  ...extensionOverrides,
})
assertEnvironment(productionEnabled.services.relay, extensionOverrides)
assertEnvironment(productionEnabled.services['relay-worker'], extensionOverrides)

console.log('Relay Extension Compose contract passed')
