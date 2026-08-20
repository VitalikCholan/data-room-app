import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { queryKeys } from '../api/keys'

export type SearchHit = {
  id: string
  name: string
  type: 'FOLDER' | 'FILE'
  sizeBytes: number | null
  updatedAt: string
  parentId: string | null
  /** The folder holding the hit. Null only when the hit is the caller's own scope root. */
  parentName: string | null
}

export type SearchResponse = { items: SearchHit[]; nextCursor: string | null }

/** The server's own minimum: a shorter term is a 422, so it is never sent. */
export const MIN_SEARCH_LENGTH = 2

/**
 * Keystrokes are not queries. Typing "audit" would otherwise be four wasted round trips
 * and four cache entries, and the last of them could land out of order.
 */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** True when a term is worth a request — the one place that answers it. */
export const isSearchable = (term: string) => term.trim().length >= MIN_SEARCH_LENGTH

/**
 * `scopeParentId` is what keeps a share recipient inside their share: passing it makes
 * the API resolve access from that node and search only its subtree. An owner passes
 * null, and the whole room answers.
 */
export function useSearch(roomId: string, term: string, scopeParentId: string | null) {
  const trimmed = term.trim()
  return useQuery({
    queryKey: queryKeys.search.results(roomId, scopeParentId, trimmed),
    enabled: isSearchable(trimmed),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ q: trimmed, limit: '50' })
      if (scopeParentId) params.set('parentId', scopeParentId)
      return api.get<SearchResponse>(`/rooms/${roomId}/search?${params.toString()}`, { signal })
    },
  })
}
