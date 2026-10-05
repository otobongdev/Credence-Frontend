/**
 * @file src/api/index.test.ts
 *
 * Boundary and recovery coverage for the public API surface exported by
 * `src/api/index.ts` — the barrel every application caller reaches through
 * `from '../api'`.
 *
 * ## What is covered (mapped to the issue's acceptance criteria)
 *
 * 1. **Public surface / compatibility** — every documented export is the same
 *    reference as its source module, test-only escape hatches stay out of the
 *    barrel, and error classes keep their hierarchy and legacy defaults.
 * 2. **Normal operation (success)** — requests resolve parsed payloads with
 *    deterministic headers; 204 and non-JSON bodies resolve without data loss.
 * 3. **Invalid input (rejection, no side effects)** — path, amount, size, and
 *    idempotency-key boundaries reject *before* any network effect, and
 *    diagnostics never echo secrets.
 * 4. **Duplicate inputs (idempotency)** — a keyed operation commits at most
 *    once, conflicting re-use is rejected, and failures release the key so a
 *    retry can run.
 * 5. **Retries and failure recovery** — network failures are classified
 *    retryable, `withRetry` bounds attempts deterministically, and rate-limit
 *    windows recover.
 * 6. **Loading and stale states (timing boundaries)** — pending requests do
 *    not settle early, stale identity epochs reject pre-flight without
 *    dispatch and discard post-flight responses (no partial state), and
 *    callers without an epoch are unaffected.
 * 7. **Permission states** — 401/403 surface as diagnosable `ApiError`s that
 *    never leak credentials, and a denied keyed operation does not poison the
 *    replay map.
 * 8. **State-model helpers** — list validation/merge preserve data, trust
 *    score clamping is boundary-accurate, amount canonicalization is applied
 *    exactly at the wire boundary without mutating caller input.
 *
 * All tests are deterministic: no real timers are awaited, network effects
 * are stubbed, and shared module state (identity epoch, rate-limiter window,
 * audit trail, replay map) is reset around every test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from './index'
import * as client from './client'
import * as amount from './amount'
import * as rateLimit from './rateLimit'
import * as types from './types'
import { getWalletAuditTrail, resetWalletAuditTrail } from '../lib/walletAudit'

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  // Shared singletons live at module scope; reset them so each test observes
  // the same starting state (epoch 0, empty rate-limit window, empty audit).
  client.resetIdentityEpoch()
  client.resetApiRateLimiter()
  resetWalletAuditTrail()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 1. Public surface — compatibility contract of the barrel
// ---------------------------------------------------------------------------

describe('public surface (compatibility contract)', () => {
  it('re-exports the client entry points as the exact source references', () => {
    expect(api.apiFetch).toBe(client.apiFetch)
    expect(api.ApiError).toBe(client.ApiError)
    expect(api.ApiRateLimitError).toBe(client.ApiRateLimitError)
    expect(api.ApiAmountError).toBe(client.ApiAmountError)
    expect(api.ApiSessionConflictError).toBe(client.ApiSessionConflictError)
    expect(api.ApiBodyTooLargeError).toBe(client.ApiBodyTooLargeError)
    expect(api.MAX_REQUEST_BODY_BYTES).toBe(client.MAX_REQUEST_BODY_BYTES)
    expect(api.getIdentityEpoch).toBe(client.getIdentityEpoch)
    expect(api.advanceIdentityEpoch).toBe(client.advanceIdentityEpoch)
  })

  it('re-exports the amount helpers as the exact source references', () => {
    expect(api.AmountError).toBe(amount.AmountError)
    expect(api.parseAmount).toBe(amount.parseAmount)
    expect(api.tryParseAmount).toBe(amount.tryParseAmount)
    expect(api.compareAmounts).toBe(amount.compareAmounts)
    expect(api.resolveAmountRules).toBe(amount.resolveAmountRules)
    expect(api.MAX_INT64).toBe(amount.MAX_INT64)
    expect(api.USDC_SCALE).toBe(amount.USDC_SCALE)
    expect(api.MAX_SCALE).toBe(amount.MAX_SCALE)
  })

  it('re-exports the rate limiter, retry, validation, and message helpers', () => {
    expect(api.ApiRateLimiter).toBe(rateLimit.ApiRateLimiter)
    expect(api.withRetry).toBe(types.withRetry)
    expect(api.validateApiListResponse).toBe(types.validateApiListResponse)
    expect(api.mergeApiListResponse).toBe(types.mergeApiListResponse)
    expect(api.clampTrustScore).toBe(types.clampTrustScore)
    expect(api.toUserMessage).toBe(types.toUserMessage)
  })

  it('keeps test-only and module-private escape hatches out of the barrel', () => {
    const privateHooks = [
      'defaultApiRateLimiter',
      'resetApiRateLimiter',
      'apiRateLimiterSnapshot',
      'setIdentityEpoch',
      'resetIdentityEpoch',
      'buildUrl',
      'normalizeBaseUrl',
      'isJsonBody',
      'errorMessage',
      'API_BASE_URL',
      'DEFAULT_API_RATE_LIMIT',
      'readApiRateLimitOverrides',
    ]
    for (const name of privateHooks) {
      expect(api, `barrel must not export ${name}`).not.toHaveProperty(name)
    }
  })

  it('keeps the documented error hierarchy, statuses, and codes', () => {
    const rateLimitError = new api.ApiRateLimitError(1500)
    expect(rateLimitError).toBeInstanceOf(api.ApiError)
    expect(rateLimitError.status).toBe(429)
    expect(rateLimitError.retryAfterMs).toBe(1500)
    expect(rateLimitError.code).toBe('http_error')

    const amountError = new api.ApiAmountError('amount', 'NEGATIVE', 'must be positive')
    expect(amountError).toBeInstanceOf(api.ApiError)
    expect(amountError.status).toBe(400)
    expect(amountError.field).toBe('amount')
    expect(amountError.payload).toEqual({ field: 'amount', code: 'NEGATIVE' })

    const conflict = new api.ApiSessionConflictError(1, 2)
    expect(conflict).toBeInstanceOf(api.ApiError)
    expect(conflict.status).toBe(409)
    expect(conflict.staleEpoch).toBe(1)
    expect(conflict.currentEpoch).toBe(2)
    expect(conflict.payload).toEqual({ staleEpoch: 1, currentEpoch: 2 })

    const tooLarge = new api.ApiBodyTooLargeError(api.MAX_REQUEST_BODY_BYTES)
    expect(tooLarge).toBeInstanceOf(api.ApiError)
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.limitBytes).toBe(1_048_576)
  })

  it('preserves legacy three-argument ApiError construction (code stays undefined)', () => {
    const legacy = new api.ApiError(500, 'boom')

    expect(legacy.code).toBeUndefined()
    expect(legacy).toBeInstanceOf(Error)
    expect(legacy.name).toBe('ApiError')
    expect(legacy.message).toBe('boom')
  })

  it('pins the documented body-size boundary constant', () => {
    expect(api.MAX_REQUEST_BODY_BYTES).toBe(1_048_576)
  })
})

// ---------------------------------------------------------------------------
// 2. Normal operation (success)
// ---------------------------------------------------------------------------

describe('normal operation (success)', () => {
  it('resolves parsed JSON with deterministic default headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ score: 720 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.apiFetch<{ score: number }>('/trust-score/GABC')

    expect(result).toEqual({ score: 720 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/trust-score/GABC')

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('X-Correlation-ID')).toMatch(/^api-fetch-/)
    expect(headers.has('Content-Type')).toBe(false)
  })

  it('passes caller headers through and never overrides a caller correlation id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await api.apiFetch('/me', {
      headers: { Authorization: 'Bearer session-token', 'X-Correlation-ID': 'trace-42' },
    })

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer session-token')
    expect(headers.get('X-Correlation-ID')).toBe('trace-42')
    expect(headers.get('Accept')).toBe('application/json')
  })

  it('sets Content-Type only for JSON bodies', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await api.apiFetch('/bonds', { method: 'POST', body: { amount: '1.00' } })

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('resolves undefined for 204 responses without inventing a body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.apiFetch('/bonds/1')).resolves.toBeUndefined()
  })

  it('returns plain text for non-JSON success bodies', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('plain payload', { headers: { 'Content-Type': 'text/plain' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.apiFetch('/raw')).resolves.toBe('plain payload')
  })
})

// ---------------------------------------------------------------------------
// 3. Invalid input boundaries — rejected before any network effect
// ---------------------------------------------------------------------------

describe('invalid input boundaries (no network effect)', () => {
  it.each([
    ['empty path', ''],
    ['whitespace-only path', '   '],
    ['origin-relative path', '//evil.example/x'],
    ['backslash traversal', '/bonds\\..\\..\\admin'],
    ['URL fragment', '/bonds#other-resource'],
    ['control character', '/bonds\nx'],
  ])('rejects %s with a stable classification before dispatch', async (_label, path) => {
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.apiFetch(path)).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: 'invalid_request_url',
    } satisfies Partial<api.ApiError>)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects non-string paths before dispatch', async () => {
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.apiFetch(42 as unknown as string)).rejects.toMatchObject({
      status: 0,
      code: 'invalid_request_url',
    } satisfies Partial<api.ApiError>)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('strips query strings so secrets never reach diagnostics', async () => {
    await expect(api.apiFetch('/bonds?token=sup3rsecret#frag')).rejects.toMatchObject({
      payload: {
        code: 'invalid_request_url',
        reason: 'path must not contain a URL fragment',
        path: '/bonds?<redacted>',
      },
    } satisfies Partial<api.ApiError>)
  })

  it('replaces control characters and bounds long paths in diagnostics', async () => {
    await expect(api.apiFetch('/bo\nnds')).rejects.toMatchObject({
      payload: { path: '/bo?nds' },
    } satisfies Partial<api.ApiError>)

    await expect(api.apiFetch(`/${'a'.repeat(500)}#frag`)).rejects.toMatchObject({
      payload: { path: expect.stringMatching(/^.{80}…$/) as string },
    } satisfies Partial<api.ApiError>)
  })

  it('rejects an invalid amount before dispatch and never mutates the caller body', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const body = { amount: '1.5.0', memo: 'keep' }

    await expect(
      api.apiFetch('/bonds', { method: 'POST', body, amountFields: ['amount'] })
    ).rejects.toMatchObject({ name: 'ApiAmountError', status: 400, field: 'amount' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(body).toEqual({ amount: '1.5.0', memo: 'keep' })
  })

  it('rejects a declared amount field that is missing', async () => {
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      api.apiFetch('/bonds', { method: 'POST', body: { memo: 'x' }, amountFields: ['amount'] })
    ).rejects.toMatchObject({ name: 'ApiAmountError', status: 400, field: 'amount' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects amountFields applied to a non-object body', async () => {
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      api.apiFetch('/bonds', {
        method: 'POST',
        body: 'raw' as unknown as Record<string, unknown>,
        amountFields: ['amount'],
      })
    ).rejects.toMatchObject({
      name: 'ApiAmountError',
      status: 400,
      payload: { code: 'INVALID_BODY' },
    } satisfies Partial<api.ApiAmountError>)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body one byte over the limit and accepts one inside it', async () => {
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      api.apiFetch('/bonds', {
        method: 'POST',
        body: { data: 'x'.repeat(api.MAX_REQUEST_BODY_BYTES + 1) },
      })
    ).rejects.toMatchObject({ name: 'ApiBodyTooLargeError', status: 413 })
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await expect(
      api.apiFetch('/bonds', {
        method: 'POST',
        body: { data: 'x'.repeat(api.MAX_REQUEST_BODY_BYTES - 100) },
      })
    ).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty or whitespace idempotency key before dispatch', async () => {
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      api.apiFetch('/bonds', { method: 'POST', idempotencyKey: '   ' })
    ).rejects.toMatchObject({
      status: 400,
      payload: { code: 'invalid_idempotency_key' },
    } satisfies Partial<api.ApiError>)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. Duplicate inputs — idempotency: at-most-once effects
// ---------------------------------------------------------------------------

// The idempotency replay map is process-scoped module state, so every test
// uses a unique key to stay independent of entries left behind by others.
describe('duplicate operations (idempotency)', () => {
  it('commits one network effect for the same key issued concurrently', async () => {
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return jsonResponse({ id: 'bond-1' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const request = () =>
      api.apiFetch<{ id: string }>('/bonds', {
        method: 'POST',
        idempotencyKey: 'dup-concurrent-op',
        body: { amount: '1.00' },
      })
    const [first, second] = await Promise.all([request(), request()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ id: 'bond-1' })
    expect(second).toEqual(first)
  })

  it('rejects reuse of a key with a different payload instead of double-committing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'bond-1' }))
    vi.stubGlobal('fetch', fetchMock)

    await api.apiFetch('/bonds', {
      method: 'POST',
      idempotencyKey: 'dup-conflict-op',
      body: { amount: '1.00' },
    })

    await expect(
      api.apiFetch('/bonds', {
        method: 'POST',
        idempotencyKey: 'dup-conflict-op',
        body: { amount: '9.99' },
      })
    ).rejects.toMatchObject({
      status: 409,
      payload: { code: 'idempotency_key_conflict' },
    } satisfies Partial<api.ApiError>)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('releases the key after a failure so a retry can run', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse({ id: 'bond-1' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      api.apiFetch('/bonds', { method: 'POST', idempotencyKey: 'retry-me' })
    ).rejects.toMatchObject({ status: 0, code: 'network_error' })

    await expect(
      api.apiFetch('/bonds', { method: 'POST', idempotencyKey: 'retry-me' })
    ).resolves.toEqual({ id: 'bond-1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats distinct keys as distinct operations', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse({ id: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    const first = api.apiFetch('/bonds', { method: 'POST', idempotencyKey: 'op-a' })
    const second = api.apiFetch('/bonds', { method: 'POST', idempotencyKey: 'op-b' })

    await expect(Promise.all([first, second])).resolves.toEqual([{ id: 1 }, { id: 2 }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// 5. Retries and failure recovery
// ---------------------------------------------------------------------------

describe('retry and recovery', () => {
  it('classifies transport failures as retryable network errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.apiFetch('/bonds')).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: 'network_error',
      message: 'Failed to fetch',
    } satisfies Partial<api.ApiError>)
  })

  it('recovers when an immediate retry succeeds after a transport failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.apiFetch('/bonds')).rejects.toMatchObject({ code: 'network_error' })
    await expect(api.apiFetch('/bonds')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('withRetry reports intermediate failures and resolves on a later attempt', async () => {
    const attempts: number[] = []
    const sleeps: number[] = []
    const seen: Array<[number, unknown]> = []
    let call = 0

    const result = await api.withRetry(
      async (attempt) => {
        attempts.push(attempt)
        call += 1
        if (call < 3) throw new Error(`transient-${attempt}`)
        return 'recovered'
      },
      {
        onRetry: (attempt, error) => seen.push([attempt, error]),
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      }
    )

    expect(result).toBe('recovered')
    expect(attempts).toEqual([1, 2, 3])
    expect(sleeps).toEqual([100, 200]) // deterministic exponential backoff
    expect(seen).toHaveLength(2)
    expect((seen[0][1] as Error).message).toBe('transient-1')
    expect((seen[1][1] as Error).message).toBe('transient-2')
  })

  it('withRetry surfaces only the final error after exhausting attempts', async () => {
    const intermediate: unknown[] = []
    const errors = [new Error('first'), new Error('last')]
    let call = 0

    await expect(
      api.withRetry(
        async () => {
          const error = errors[Math.min(call, errors.length - 1)]
          call += 1
          throw error
        },
        {
          maxAttempts: 2,
          onRetry: (_attempt, error) => intermediate.push(error),
          sleep: async () => {},
        }
      )
    ).rejects.toThrow('last')

    expect(intermediate).toHaveLength(1)
    expect((intermediate[0] as Error).message).toBe('first')
  })

  it('withRetry clamps a non-positive attempt budget to exactly one attempt', async () => {
    let calls = 0

    await expect(
      api.withRetry(
        async () => {
          calls += 1
          return 'ran'
        },
        { maxAttempts: 0, sleep: async () => {} }
      )
    ).resolves.toBe('ran')
    expect(calls).toBe(1)
  })

  it('recovers after the client-side rate-limit window resets', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const maxRequests = rateLimit.DEFAULT_API_RATE_LIMIT.maxRequests

    for (let index = 0; index < maxRequests; index += 1) {
      await expect(api.apiFetch(`/gen/${index}`)).resolves.toEqual({ ok: true })
    }
    expect(fetchMock).toHaveBeenCalledTimes(maxRequests)

    await expect(api.apiFetch('/gen/over')).rejects.toMatchObject({
      name: 'ApiRateLimitError',
      status: 429,
    } satisfies Partial<api.ApiError>)
    // The denial happens before dispatch — no hidden request is fired.
    expect(fetchMock).toHaveBeenCalledTimes(maxRequests)

    // Window expiry (represented by the documented reset hook) lets the next
    // call through again.
    client.resetApiRateLimiter()
    await expect(api.apiFetch('/gen/after-window')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(maxRequests + 1)
  })
})

// ---------------------------------------------------------------------------
// 6. Loading and stale states — timing boundaries
// ---------------------------------------------------------------------------

describe('loading and stale states (timing boundaries)', () => {
  it('keeps a request pending until the response arrives (loading is not a settlement)', async () => {
    const gate = deferred<Response>()
    fetchMock.mockReturnValueOnce(gate.promise)
    vi.stubGlobal('fetch', fetchMock)

    let settled = false
    const pending = api.apiFetch<{ ok: boolean }>('/slow').then((value) => {
      settled = true
      return value
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    gate.resolve(jsonResponse({ ok: true }))
    await expect(pending).resolves.toEqual({ ok: true })
    expect(settled).toBe(true)
  })

  it('rejects a stale epoch pre-flight without dispatching, then recovers with a fresh epoch', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    api.advanceIdentityEpoch() // epoch is now 1; captured 0 is stale

    await expect(api.apiFetch('/bonds', { identityEpoch: 0 })).rejects.toMatchObject({
      name: 'ApiSessionConflictError',
      status: 409,
      staleEpoch: 0,
      currentEpoch: 1,
    } satisfies Partial<api.ApiSessionConflictError>)
    expect(fetchMock).not.toHaveBeenCalled()

    await expect(
      api.apiFetch('/bonds', { identityEpoch: api.getIdentityEpoch() })
    ).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('discards an in-flight response when the epoch advances post-flight', async () => {
    const gate = deferred<Response>()
    fetchMock.mockReturnValueOnce(gate.promise)
    vi.stubGlobal('fetch', fetchMock)

    let resolvedWith: unknown = 'pending'
    let rejectedWith: unknown = null
    const pending = api
      .apiFetch<{ secret: string }>('/bonds', {
        identityEpoch: api.getIdentityEpoch(),
      })
      .then(
        (value) => {
          resolvedWith = value
        },
        (error) => {
          rejectedWith = error
        }
      )

    api.advanceIdentityEpoch() // disconnect happens while in flight
    gate.resolve(jsonResponse({ secret: 'stale-data' }))
    await pending

    expect(resolvedWith).toBe('pending') // stale body is discarded, never committed
    expect(rejectedWith).toBeInstanceOf(api.ApiSessionConflictError)
    expect(rejectedWith).toMatchObject({ staleEpoch: 0, currentEpoch: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves callers that omit identityEpoch unaffected by epoch advances', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    api.advanceIdentityEpoch()
    api.advanceIdentityEpoch()

    await expect(api.apiFetch('/bonds')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('commits every request while the epoch stays stable across concurrency', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const epoch = api.getIdentityEpoch()

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        api.apiFetch(`/bonds/${index}`, { identityEpoch: epoch })
      )
    )

    expect(results).toHaveLength(5)
    expect(results.every((result) => (result as { ok: boolean }).ok)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })
})

// ---------------------------------------------------------------------------
// 7. Permission states — diagnosable failures without credential leaks
// ---------------------------------------------------------------------------

describe('permission states', () => {
  it('surfaces 401 as an http_error that keeps the payload for the UI', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Unauthorized', code: 'unauthenticated' }, { status: 401 })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.apiFetch('/protected')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'http_error',
      message: 'Unauthorized',
      payload: { message: 'Unauthorized', code: 'unauthenticated' },
    } satisfies Partial<api.ApiError>)
  })

  it('surfaces 403 denials with the server message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Forbidden' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.apiFetch('/tenant-data')).rejects.toMatchObject({
      status: 403,
      code: 'http_error',
      message: 'Forbidden',
    } satisfies Partial<api.ApiError>)
  })

  it('forwards the Authorization header without ever echoing it back in errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const failure = (await api
      .apiFetch('/protected', {
        headers: { Authorization: 'Bearer super-secret-token' },
      })
      .catch((error: unknown) => error)) as api.ApiError

    const sentHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers
    expect(sentHeaders.get('Authorization')).toBe('Bearer super-secret-token')

    expect(failure.message).not.toContain('super-secret-token')
    expect(JSON.stringify(failure.payload)).not.toContain('super-secret-token')
    expect(String(failure.message)).not.toContain('Bearer')
  })

  it('does not poison the replay map when a keyed operation is denied', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const key = 'auth-retry-op'

    await expect(
      api.apiFetch('/protected', { method: 'POST', idempotencyKey: key })
    ).rejects.toMatchObject({ status: 401 })

    // After re-authentication the same key must be dispatchable again.
    await expect(
      api.apiFetch('/protected', { method: 'POST', idempotencyKey: key })
    ).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('records diagnosable audit events for success and denial', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await api.apiFetch('/public-data')
    await api.apiFetch('/protected-data').catch(() => undefined)

    const trail = getWalletAuditTrail()
    const success = trail.find((event) => event.type === 'action_succeeded')
    const failure = trail.find((event) => event.type === 'action_failed')

    expect(success?.correlationId).toMatch(/^api-fetch-/)
    expect(success?.metadata).toMatchObject({ path: '/public-data', status: 200 })
    expect(failure?.metadata).toMatchObject({ path: '/protected-data', status: 401 })
  })
})

// ---------------------------------------------------------------------------
// 8. Error messages and fallbacks — deterministic, user-visible output
// ---------------------------------------------------------------------------

describe('user-visible error messages', () => {
  it('uses the server-provided message and a stable fallback otherwise', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'boom' }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.apiFetch('/a')).rejects.toMatchObject({ message: 'boom' })
    await expect(api.apiFetch('/b')).rejects.toMatchObject({
      message: 'Request failed with status 500',
    })
  })

  it('keeps toUserMessage deterministic for untrusted values', () => {
    expect(api.toUserMessage(new Error('Bond not found'))).toBe('Bond not found')
    const fromNumber = api.toUserMessage(42)
    expect(fromNumber.length).toBeGreaterThan(0)
    expect(api.toUserMessage(undefined)).toBe(fromNumber)
  })
})

// ---------------------------------------------------------------------------
// 9. State-model helpers — boundaries without silent data loss
// ---------------------------------------------------------------------------

describe('state-model helpers (boundary accuracy)', () => {
  it('validates list envelopes and normalizes a null cursor to undefined', () => {
    const missingItems = api.validateApiListResponse({ nextCursor: 'c1' }, (item) => ({
      ok: true,
      value: item as { id: string },
    }))
    expect(missingItems).toEqual({ ok: false, reason: 'missing_field' })

    const notAnObject = api.validateApiListResponse('nope', (item) => ({
      ok: true,
      value: item as { id: string },
    }))
    expect(notAnObject).toEqual({ ok: false, reason: 'not_an_object' })

    const normalized = api.validateApiListResponse(
      { items: [{ id: 'a' }], nextCursor: null },
      (item) => ({ ok: true, value: item as { id: string } })
    )
    expect(normalized).toEqual({
      ok: true,
      value: { items: [{ id: 'a' }], nextCursor: undefined },
    })
  })

  it('merges pages without losing or duplicating items', () => {
    const previous = {
      items: [
        { id: 'a', amount: '1' },
        { id: 'b', amount: '2' },
      ],
      nextCursor: 'page-2',
    }
    const snapshot = JSON.stringify(previous)

    const merged = api.mergeApiListResponse(
      previous,
      {
        items: [
          { id: 'b', amount: '2-refreshed' },
          { id: 'c', amount: '3' },
        ],
      },
      (item) => item.id
    )

    expect(merged.items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(merged.nextCursor).toBeUndefined() // new page is authoritative
    expect(JSON.stringify(previous)).toBe(snapshot) // previous page never mutated
  })

  it('clamps trust scores at the inclusive boundaries', () => {
    expect(api.clampTrustScore(-5)).toBe(0)
    expect(api.clampTrustScore(0)).toBe(0)
    expect(api.clampTrustScore(100)).toBe(100)
    expect(api.clampTrustScore(150)).toBe(100)
    expect(api.clampTrustScore(Number.NaN)).toBeNull()
    expect(api.clampTrustScore('90')).toBeNull()
  })

  it('canonicalizes declared amount fields exactly at the wire boundary', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const body = { amount: '1.5' }

    await api.apiFetch('/bonds', { method: 'POST', body, amountFields: ['amount'] })

    const wireBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      amount: string
    }
    expect(wireBody.amount).toBe('1.50') // canonical USDC wire format
    expect(body).toEqual({ amount: '1.5' }) // caller input untouched
  })

  it('parses and compares amounts at scale boundaries', () => {
    expect(api.USDC_SCALE).toBe(2)
    expect(api.MAX_SCALE).toBe(18)
    expect(api.parseAmount('0.01')).toBe('0.01') // exactly one cent (boundary)
    expect(api.tryParseAmount('0.001').ok).toBe(false) // one digit over the scale
    expect(api.parseAmount('0.000000000000000001', { scale: 18 })).toBe('0.000000000000000001') // scale-18 boundary
    expect(api.compareAmounts('1', '1.00')).toBe(0)
    expect(api.compareAmounts('2', '1')).toBe(1)
    expect(api.compareAmounts('1', '2')).toBe(-1)
  })
})
