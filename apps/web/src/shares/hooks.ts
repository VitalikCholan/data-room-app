import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { queryKeys } from '../api/keys'

export type Share = {
  id: string
  nodeId: string
  mode: 'PUBLIC_LINK' | 'USER'
  role: 'VIEWER'
  granteeEmail: string | null
  granteeId: string | null
  createdAt: string
  revokedAt: string | null
}

/**
 * `token` and `url` come back for a public link and for nothing else — the API mints the
 * secret, hands it over once, and keeps only `sha256(token)`. There is no endpoint that
 * can ever return it again, which is why the dialog holds it in component state instead
 * of re-reading it from the cache.
 */
export type CreateShareResult = { share: Share; token?: string; url?: string }

export type CreateShareInput = { mode: 'PUBLIC_LINK' } | { mode: 'USER'; email: string }

export const useShares = (nodeId: string) =>
  useQuery({
    queryKey: queryKeys.nodes.shares(nodeId),
    // Always fresh: a link created or revoked in another tab a minute ago changes who
    // can read this folder, so this is the one list that must never be served stale.
    staleTime: 0,
    queryFn: () => api.get<Share[]>(`/nodes/${nodeId}/shares`),
  })

export function useCreateShare(nodeId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateShareInput) =>
      api.post<CreateShareResult>(`/nodes/${nodeId}/shares`, input),
    // No optimistic row: the server assigns the id, and for an email grant it may revive
    // a revoked row rather than create one — only the response knows which happened.
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.nodes.shares(nodeId) }),
  })
}

export function useRevokeShare(nodeId: string) {
  const client = useQueryClient()
  const key = queryKeys.nodes.shares(nodeId)
  return useMutation({
    mutationFn: (shareId: string) => api.del<Share>(`/shares/${shareId}`),
    // Optimistically stamped rather than removed: the list keeps revoked rows out of
    // sight but the server keeps them, and a failed revoke must be able to put the row
    // back exactly as it was.
    onMutate: (shareId) => {
      const previous = client.getQueryData<Share[]>(key)
      client.setQueryData<Share[]>(key, (shares) =>
        shares?.map((share) =>
          share.id === shareId
            ? { ...share, revokedAt: share.revokedAt ?? new Date().toISOString() }
            : share,
        ),
      )
      return { previous }
    },
    onError: (_error, _shareId, context) => client.setQueryData(key, context?.previous),
    onSettled: () => void client.invalidateQueries({ queryKey: key }),
  })
}
