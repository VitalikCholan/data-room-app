import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiRequest, fetchBinary, getAccessToken, setAccessToken, setShareToken } from './client'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('apiRequest', () => {
  beforeEach(() => {
    setAccessToken(null)
    setShareToken(null)
    vi.restoreAllMocks()
  })

  it('prefixes the base url and returns parsed json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiRequest('GET', '/rooms')).resolves.toEqual({ ok: true })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/rooms')
  })

  it('attaches the bearer token when signed in', async () => {
    setAccessToken('tok-1')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    await apiRequest('GET', '/rooms')
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  it('attaches the share token for guests instead of a bearer', async () => {
    setShareToken('share-1')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    await apiRequest('GET', '/rooms/r1/nodes')
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-Share-Token']).toBe('share-1')
    expect(headers.Authorization).toBeUndefined()
  })

  it('refreshes once on 401 and replays the original request', async () => {
    setAccessToken('stale')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS', message: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh', user: { id: 'u1' } }, 201))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('GET', '/rooms')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/refresh')
    expect(getAccessToken()).toBe('fresh')
  })

  it('sends the refresh cookie first-party on both the refresh and the replay', async () => {
    setAccessToken('stale')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS' }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh' }, 201))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await apiRequest('GET', '/rooms')

    // Without credentials the httpOnly refresh cookie never leaves the browser and
    // every session dies at the 15-minute mark — silently, and only in production.
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).credentials).toBe('include')
    }
  })

  it('does not attempt a second refresh for the same request', async () => {
    setAccessToken('stale')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS' }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh' }, 201))
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS' }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('GET', '/rooms')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('clears the session and notifies when refresh itself fails', async () => {
    setAccessToken('stale')
    const onUnauth = vi.fn()
    const { onUnauthenticated } = await import('./client')
    onUnauthenticated(onUnauth)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS' }, 401))
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS' }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('GET', '/rooms')).rejects.toBeInstanceOf(ApiError)
    expect(getAccessToken()).toBeNull()
    expect(onUnauth).toHaveBeenCalled()
  })

  it('never tries to refresh a guest request', async () => {
    setShareToken('share-1')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 'NOT_FOUND' }, 404))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiRequest('GET', '/rooms/r1/nodes')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces the server error code and details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 'NAME_CONFLICT', message: 'exists', details: { existingNodeId: 'n1' } }, 409),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiRequest('POST', '/rooms/r/folders', { body: { name: 'x' } })).rejects.toMatchObject({
      status: 409,
      code: 'NAME_CONFLICT',
      details: { existingNodeId: 'n1' },
    })
  })

  it('falls back to a readable message when the body is not json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })))
    await expect(apiRequest('GET', '/rooms')).rejects.toMatchObject({ status: 502, code: 'UNKNOWN' })
  })

  it('returns undefined for a 204 rather than throwing on empty json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(apiRequest('DELETE', '/shares/s1')).resolves.toBeUndefined()
  })
})

describe('fetchBinary', () => {
  beforeEach(() => {
    setAccessToken(null)
    setShareToken(null)
    vi.restoreAllMocks()
  })

  it('returns the bytes and never sends credentials across the redirect to the bucket', async () => {
    setAccessToken('tok-1')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Blob(['%PDF']), { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const blob = await fetchBinary('/nodes/d1/content')
    expect(blob.type).toBe('application/pdf')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.credentials).toBe('same-origin')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  it('types the blob itself and never from the response header', async () => {
    // The bytes are attacker-controlled by design: a presigned PUT declares
    // application/pdf and can send anything. If the type came from the header, an
    // object url made from this blob would load HTML as a same-origin document with
    // access to our DOM, our session and window.parent.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<script>parent.document.cookie</script>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    )

    const blob = await fetchBinary('/nodes/d1/content')
    expect(blob.type).toBe('application/pdf')
  })

  it('throws the withdrawn-content error rather than an empty blob', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ code: 'GONE', message: 'File content is no longer available' }, 410)),
    )
    await expect(fetchBinary('/nodes/d1/content')).rejects.toMatchObject({ status: 410, code: 'GONE' })
  })
})
