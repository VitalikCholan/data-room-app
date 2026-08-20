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

type RequestOptions = { body?: unknown; signal?: AbortSignal }

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { code?: string; message?: string; details?: Record<string, unknown> }
    return new ApiError(res.status, body.code ?? 'UNKNOWN', body.message ?? res.statusText, body.details)
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
    credentials: 'include',
    signal: opts.signal,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

export async function apiRequest<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(method, path, opts)

  // Exactly one silent refresh attempt, and never for a guest — a share token does
  // not expire, so a 401 there means something else is wrong.
  if (res.status === 401 && !shareToken && path !== '/auth/refresh') {
    if (await refreshSession()) {
      res = await send(method, path, opts)
    } else {
      setAccessToken(null)
      unauthenticatedHandler?.()
    }
  }

  if (!res.ok) throw await parseError(res)
  if (res.status === 204 || res.headers.get('Content-Length') === '0') return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => apiRequest<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown) => apiRequest<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>('PATCH', path, { body }),
  del: <T>(path: string) => apiRequest<T>('DELETE', path),
}
