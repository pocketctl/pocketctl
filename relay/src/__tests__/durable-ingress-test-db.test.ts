import { describe, expect, test } from 'vitest'
import { durableIngressTestDatabaseConfig } from './durable-ingress-test-db.js'

describe('durable ingress destructive test database configuration', () => {
  test('accepts only the explicitly named loopback test role and database', () => {
    expect(durableIngressTestDatabaseConfig(
      'postgres://pocketctl_durable_ingress_test:secret@127.0.0.1:5432/pocketctl_durable_ingress_test',
    )).toMatchObject({
      database: 'pocketctl_durable_ingress_test',
      user: 'pocketctl_durable_ingress_test',
    })
  })

  test.each([
    'postgres://postgres:secret@127.0.0.1:5432/pocketctl_durable_ingress_test',
    'postgres://pocketctl_durable_ingress_test:secret@db.example.test:5432/pocketctl_durable_ingress_test',
    'postgres://pocketctl_durable_ingress_test:secret@127.0.0.1:5432/pocketctl',
    'postgres://pocketctl_durable_ingress_test:secret@127.0.0.1:5432/pocketctl_durable_ingress_test?options=--search_path%3Dshared',
  ])('rejects unsafe destructive endpoint %s', (url) => {
    expect(() => durableIngressTestDatabaseConfig(url)).toThrow(/TEST_DATABASE_URL/)
  })
})
