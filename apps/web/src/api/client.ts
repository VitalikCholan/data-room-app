const BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '/api'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

let accessToken: string | null = null
let shareToken: string | null = null
let unauthenticatedHandler: (() => void) | null = null

export const setAccessToken = (token: string | null) => {
  accessToken = token
}
export const getAccessToken = () => accessToken
export const setShareToken = (token: string | null) => {
  shareToken = token
}
export const getShareToken = () => shareToken
/** The AuthProvider subscribes here so a dead session redirects exactly once. */
export const onUnauthenticated = (handler: () => void) => {
  unauthenticatedHandler = handler
}

type RequestOptions = { body?: unknown; signal?: AbortSignal; credentials?: RequestCredentials }

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as {
      code?: string
      message?: string
      details?: Record<string, unknown>
    }
    return new ApiError(
      res.status,
      body.code ?? 'UNKNOWN',
      body.message ?? res.statusText,
      body.details,
    )
  } catch {
    return new ApiError(res.status, 'UNKNOWN', res.statusText || 'Request failed')
  }
}

async function refreshSession(): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
  if (!res.ok) return false
  const body = (await res.json()) as { accessToken: string }
  setAccessToken(body.accessToken)
  return true
}

async function send(method: string, path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  // A guest is identified by the share token alone; mixing in a stale bearer would
  // make the API resolve the wrong identity.
  if (shareToken) headers['X-Share-Token'] = shareToken
  else if (accessToken) headers.Authorization = `Bearer ${accessToken}`

  return fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    credentials: opts.credentials ?? 'include',
    signal: opts.signal,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

/**
 * One request with exactly one silent refresh attempt, and never for a guest — a share
 * token does not expire, so a 401 there means something else is wrong. Shared by the
 * JSON helpers and by the binary fetch below so both authenticate identically.
 */
async function sendWithRefresh(
  method: string,
  path: string,
  opts: RequestOptions,
): Promise<Response> {
  const res = await send(method, path, opts)
  if (res.status !== 401 || shareToken || path === '/auth/refresh') return res
  if (await refreshSession()) return send(method, path, opts)
  setAccessToken(null)
  unauthenticatedHandler?.()
  return res
}

export async function apiRequest<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await sendWithRefresh(method, path, opts)

  if (!res.ok) throw await parseError(res)
  if (res.status === 204 || res.headers.get('Content-Length') === '0') return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/**
 * The one endpoint that answers with bytes instead of JSON: `/nodes/:id/content`
 * 302s to a five-minute presigned GET, which the browser follows (dropping our
 * Authorization header on the way, as it must — the signature is the bucket's whole
 * credential). An error from our own API arrives before that redirect and is
 * therefore still readable, which is how 410 becomes a real state in the viewer
 * rather than a blank frame.
 *
 * The bytes are fetched rather than pointed at from an iframe because an iframe
 * request carries neither the bearer nor the share token, so the API would answer
 * every one of them with 401.
 *
 * `credentials: 'same-origin'` is load-bearing, not tidiness. Our own leg of the
 * request is same-origin, so the session cookie still travels; the bucket leg is not,
 * and a credentialed cross-origin request forbids the `Access-Control-Allow-Origin: *`
 * that object stores answer with — the read would fail CORS with the bytes already on
 * the wire.
 */
export async function fetchBinary(path: string, opts: RequestOptions = {}): Promise<Blob> {
  const res = await sendWithRefresh('GET', path, { ...opts, credentials: 'same-origin' })
  if (!res.ok) throw await parseError(res)
  // The blob's type is ours, never the response's. `res.blob()` would take it from a
  // remote Content-Type header, and the only endpoint here is rendered through
  // `URL.createObjectURL` in an iframe — a blob: url inherits OUR origin. The bytes
  // behind it are attacker-controlled by design: a presigned PUT declares
  // application/pdf and can send anything, including HTML. Typed text/html that HTML
  // would load as a same-origin document with our DOM, our session and window.parent;
  // typed application/pdf it can only ever be handed to the PDF viewer. Nothing but
  // this line stands between those two outcomes.
  return new Blob([await res.arrayBuffer()], { type: 'application/pdf' })
}

/** Everything a caller may pass alongside a body. `body` itself is the method's own argument. */
type BodyRequestOptions = Omit<RequestOptions, 'body'>

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => apiRequest<T>('GET', path, opts),
  // `opts` is how a cancellable POST — the upload's presign and confirm — passes its
  // abort signal. Callers with nothing to say still call it with two arguments.
  post: <T>(path: string, body?: unknown, opts?: BodyRequestOptions) =>
    apiRequest<T>('POST', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>('PATCH', path, { body }),
  del: <T>(path: string) => apiRequest<T>('DELETE', path),
}
