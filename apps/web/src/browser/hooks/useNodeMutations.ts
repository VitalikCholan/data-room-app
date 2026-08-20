import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { queryKeys } from '../../api/keys'
import type { NodeItem, NodeListResponse, SortMode } from './useNodeList'

type Pages = { pages: NodeListResponse[]; pageParams: unknown[] }

export type DeletionPreview = { folders: number; files: number; bytes: number; activeShares: number }

/**
 * The shared cache surgery. Every mutation hook below owns its own optimistic update
 * and its own rollback; this only hands them the primitives to do it with.
 */
function useListCache(roomId: string, parentId: string | null, sort: SortMode) {
  const client = useQueryClient()
  const key = queryKeys.nodes.list(roomId, parentId, sort)
  return {
    client,
    invalidate: () => client.invalidateQueries({ queryKey: key }),
    /**
     * Patches every loaded page, not just the first: with keyset pagination the row
     * being renamed or removed is as likely to sit on page three as on page one.
     */
    patchItems: (patch: (items: NodeItem[]) => NodeItem[]) => {
      const previous = client.getQueryData<Pages>(key)
      client.setQueryData<Pages>(key, (data) =>
        data ? { ...data, pages: data.pages.map((page) => ({ ...page, items: patch(page.items) })) } : data,
      )
      return previous
    },
    restore: (previous: Pages | undefined) => client.setQueryData(key, previous),
  }
}

/**
 * `parentId` here is a real folder id, because the API needs one — and at the room root
 * that is the root node's uuid, while the listing on screen is keyed on the `'root'`
 * sentinel (`queryKeys.nodes.list` with a null parent). The two never match there, so
 * this invalidates the whole room prefix rather than one guessed listing: the same key
 * `useMoveNode` already settles on, and the only one that cannot be wrong.
 */
export function useCreateFolder(roomId: string, parentId: string) {
  const client = useQueryClient()
  return useMutation({
    // No optimistic row: the server assigns the id, and a placeholder without one
    // cannot be navigated into or acted on.
    mutationFn: (name: string) => api.post<NodeItem>(`/rooms/${roomId}/folders`, { parentId, name }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.nodes.roomLists(roomId) })
      void client.invalidateQueries({ queryKey: queryKeys.rooms.all })
    },
  })
}

export function useRenameNode(roomId: string, parentId: string | null, sort: SortMode) {
  const { patchItems, restore, invalidate } = useListCache(roomId, parentId, sort)
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch<NodeItem>(`/nodes/${id}`, { name }),
    onMutate: ({ id, name }) => ({
      previous: patchItems((items) => items.map((item) => (item.id === id ? { ...item, name } : item))),
    }),
    onError: (_error, _vars, context) => restore(context?.previous),
    // Name is the default sort key, so the row's position — not only its label — changes.
    onSettled: () => void invalidate(),
  })
}

export function useDeleteNode(roomId: string, parentId: string | null, sort: SortMode) {
  const { patchItems, restore, invalidate, client } = useListCache(roomId, parentId, sort)
  return useMutation({
    mutationFn: (id: string) => api.del<{ id: string; deletedNodes: number }>(`/nodes/${id}`),
    onMutate: (id) => ({ previous: patchItems((items) => items.filter((item) => item.id !== id)) }),
    onError: (_error, _vars, context) => restore(context?.previous),
    onSettled: () => {
      void invalidate()
      // Room totals on the dashboard change too.
      void client.invalidateQueries({ queryKey: queryKeys.rooms.all })
    },
  })
}

export function useMoveNode(roomId: string, parentId: string | null, sort: SortMode) {
  const { patchItems, restore, client } = useListCache(roomId, parentId, sort)
  return useMutation({
    mutationFn: ({ id, targetParentId }: { id: string; targetParentId: string }) =>
      api.post<NodeItem>(`/nodes/${id}/move`, { targetParentId }),
    // The row leaves the current folder, so removing it optimistically is correct.
    onMutate: ({ id }) => ({ previous: patchItems((items) => items.filter((item) => item.id !== id)) }),
    onError: (_error, _vars, context) => restore(context?.previous),
    // Two folders changed, and only one of them is the listing on screen.
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.nodes.roomLists(roomId) }),
  })
}

/** Drives the deletion warning: what disappears, and how many people lose access. */
export function useDeletionPreview(nodeId: string | null) {
  return useQuery({
    queryKey: queryKeys.nodes.deletionPreview(nodeId ?? 'none'),
    enabled: Boolean(nodeId),
    // Always fresh: a share granted a minute ago must show up in the warning.
    staleTime: 0,
    queryFn: () => api.get<DeletionPreview>(`/nodes/${nodeId}/deletion-preview`),
  })
}
