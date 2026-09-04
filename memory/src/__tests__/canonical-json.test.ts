import { describe, expect, test } from 'vitest'
import { canonicalJsonString, canonicalPayloadHash } from '../inbox/canonical-json.js'

describe('canonical json hashing', () => {
  test('object key order does not change the digest', () => {
    const left = { b: 1, a: { d: 2, c: 3 } }
    const right = { a: { c: 3, d: 2 }, b: 1 }
    expect(canonicalJsonString(left)).toBe(canonicalJsonString(right))
    expect(canonicalPayloadHash(left).equals(canonicalPayloadHash(right))).toBe(true)
  })

  test('array order stays significant', () => {
    expect(canonicalJsonString([1, 2])).not.toBe(canonicalJsonString([2, 1]))
  })

  test('unicode payloads hash deterministically', () => {
    const left = { text: '中文   emoji 🚀 ünïcödé' }
    const right = JSON.parse(JSON.stringify(left))
    expect(canonicalJsonString(left)).toBe(canonicalJsonString(right))
  })

  test('numbers normalize through one canonical representation', () => {
    expect(canonicalJsonString({ n: 1 })).toBe(canonicalJsonString({ n: 1.0 }))
    expect(canonicalJsonString({ n: 0.5 })).toBe('{"n":0.5}')
  })

  test('null, booleans and empty containers round-trip', () => {
    expect(canonicalJsonString({ a: null, b: true, c: false, d: [], e: {} }))
      .toBe('{"a":null,"b":true,"c":false,"d":[],"e":{}}')
  })

  test('different payloads produce different digests', () => {
    expect(canonicalPayloadHash({ x: 1 }).equals(canonicalPayloadHash({ x: 2 }))).toBe(false)
  })
})
