import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { api, fetchBinary } from '../api/client'
import { queryKeys } from '../api/keys'
import { useRooms } from '../rooms/hooks'

export type FileVersion = {
  id: string
  versionNo: number
  sizeBytes: number
  mimeType: string
  createdAt: string
  isCurrent: boolean
}

/**
 * The document itself. `versionId` is null for whatever is current, which is the url the
 * content endpoint answers without being asked; a 410 means the stored object was
 * withdrawn or overwritten since it was confirmed.
 */
export function useFileContent(nodeId: string, versionId: string | null = null) {
  return useQuery({
    queryKey: queryKeys.nodes.content(nodeId, versionId),
    // Refetching a 50 MB PDF on a focus change would be a rude way to spend someone's
    // bandwidth; four minutes keeps it inside the presigned url's five-minute life.
    staleTime: 4 * 60_000,
    gcTime: 4 * 60_000,
    queryFn: ({ signal }) =>
      fetchBinary(`/nodes/${nodeId}/content${versionId ? `?version=${encodeURIComponent(versionId)}` : ''}`, {
        signal,
      }),
  })
}

/**
 * The bytes as something an iframe can render. Shared by the owner's viewer and the
 * guest's, because both must go through `fetchBinary`: an iframe pointed straight at
 * `/nodes/:id/content` carries neither the bearer nor the share token, and the blob's
 * type has to be ours rather than the bucket's (see `fetchBinary`).
 */
export function useDocumentObjectUrl(nodeId: string, versionId: string | null = null) {
  const content = useFileContent(nodeId, versionId)

  // Derived from the blob during render rather than pushed into state by an effect: the
  // url is a pure function of the bytes. The effect exists only to release it, because
  // an object url left behind pins the whole PDF in memory for the rest of the session.
  const objectUrl = useMemo(() => (content.data ? URL.createObjectURL(content.data) : null), [content.data])
  useEffect(() => {
    if (!objectUrl) return
    return () => URL.revokeObjectURL(objectUrl)
  }, [objectUrl])

  return { objectUrl, isError: content.isError, error: content.error }
}

/** Newest first, as the API sends it: the order is the server's answer, not ours to sort. */
export const useVersions = (nodeId: string) =>
  useQuery({
    queryKey: queryKeys.nodes.versions(nodeId),
    queryFn: () => api.get<FileVersion[]>(`/nodes/${nodeId}/versions`),
  })

/**
 * Restore is a write: it makes an older version the current one, so the file's size and
 * timestamp change in every listing that holds it, and the bytes behind every content
 * url for this node are no longer what they were. A VIEWER gets a 403 from the API, and
 * never sees the control that would ask (see `OwnerOnly` in the panel).
 */
export function useRestoreVersion(nodeId: string, roomId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (versionId: string) => api.post<{ id: string }>(`/nodes/${nodeId}/versions/${versionId}/restore`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.nodes.versions(nodeId) })
      // The whole room prefix, not one guessed listing: the file's row may be in any
      // folder listing and under any sort mode (see `useMoveNode`).
      void client.invalidateQueries({ queryKey: queryKeys.nodes.roomLists(roomId) })
      // Every version's bytes for this file, current included: which one is current has
      // just changed, so the cached "current" blob is the wrong document.
      void client.invalidateQueries({ queryKey: queryKeys.nodes.contentAll(nodeId) })
      // Room totals on the dashboard follow the current version's size.
      void client.invalidateQueries({ queryKey: queryKeys.rooms.all })
    },
  })
}

/**
 * Whether this caller owns the room, which is what decides if restore is theirs to
 * press. `GET /rooms` answers with the caller's own rooms and nothing else, so
 * membership in it is the only claim of ownership the client can make honestly — the
 * viewer route is reachable by a share recipient too (see `SharedWithMeList`), and the
 * listing that carries a role never runs here: this page has no folder to list.
 *
 * Null while the answer is still in flight. Callers treat that as "not an owner", so a
 * mutation control is never rendered on a guess.
 */
export function useRoomRole(roomId: string): 'OWNER' | 'VIEWER' | null {
  const rooms = useRooms()
  if (!rooms.data) return null
  return rooms.data.some((room) => room.id === roomId) ? 'OWNER' : 'VIEWER'
}
