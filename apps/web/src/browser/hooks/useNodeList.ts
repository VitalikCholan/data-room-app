import { useInfiniteQuery } from '@tanstack/react-query'
import { api, getShareToken } from '../../api/client'
import { queryKeys } from '../../api/keys'

export type NodeItem = {
  id: string
  type: 'FOLDER' | 'FILE'
  name: string
  sizeBytes: number | null
  updatedAt: string
  currentVersionId: string | null
}

export type Crumb = { id: string; name: string; type: 'FOLDER' | 'FILE' }

export type NodeListResponse = {
  items: NodeItem[]
  nextCursor: string | null
  breadcrumbs: Crumb[]
  parent: { id: string; name: string; parentId: string | null }
  role: 'OWNER' | 'VIEWER'
  scopeRootId: string
}

export type SortMode = 'name' | 'updatedAt' | 'size'

/**
 * `enabled` exists for the guest route: a share can target a single file, and listing a
 * file id is a request the API is right to refuse. The owner's browser never passes it.
 */
export function useNodeList(
  roomId: string,
  parentId: string | null,
  sort: SortMode,
  options: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: queryKeys.nodes.list(roomId, parentId, sort),
    enabled: options.enabled ?? true,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ sort, limit: '50' })
      // A guest always names the folder explicitly: their scope root is not the room root,
      // so the API must resolve access from the node rather than from the room.
      if (parentId) params.set('parentId', parentId)
      if (pageParam) params.set('cursor', pageParam)
      if (!parentId && getShareToken()) throw new Error('A share view must always specify a folder')
      return api.get<NodeListResponse>(`/rooms/${roomId}/nodes?${params.toString()}`)
    },
    getNextPageParam: (last) => last.nextCursor,
  })
}
