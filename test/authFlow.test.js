import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAuthorizeUrl,
  authorizationCacheKey,
  resolveAuthorizationAction
} from '../authFlow.js'

test('buildAuthorizeUrl includes mac and antenna query params', () => {
  const url = buildAuthorizeUrl(
    'http://127.0.0.1:3000',
    'E00000DEAD12BEEFDEADBEEF',
    '00:DE:AD:BE:EF:11',
    2
  )

  assert.equal(
    url,
    'http://127.0.0.1:3000/tags/E00000DEAD12BEEFDEADBEEF/authorize.json?mac=00%3ADE%3AAD%3ABE%3AEF%3A11&antenna=2'
  )
})

test('authorizationCacheKey is reader-scoped', () => {
  const key = authorizationCacheKey('00:DE:AD:BE:EF:11', 'E000...')
  assert.equal(
    key,
    '__garage_authorizer__/authorizing/00:DE:AD:BE:EF:11/E000...'
  )
})

test('resolveAuthorizationAction returns record_only with no door action', () => {
  assert.equal(
    resolveAuthorizationAction('record_only', { doorMoveTopic: 'x' }),
    'record_only'
  )
})

test('resolveAuthorizationAction returns misconfigured when authorized has no door config', () => {
  assert.equal(resolveAuthorizationAction('authorized', null), 'misconfigured')
})
