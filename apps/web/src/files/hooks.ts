import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { fetchBinary } from '../api/client'
import { queryKeys } from '../api/keys'

/**
 * The document itself. Under the scope cut there is no version history and no
 * `?version=` parameter to pass: the endpoint always serves the current version, and
 * a 410 means the stored object was withdrawn or overwritten since it was confirmed.
 */
export function useFileContent(nodeId: string) {
  return useQuery({
    queryKey: queryKeys.nodes.content(nodeId),
    // Refetching a 50 MB PDF on a focus change would be a rude way to spend someone's
    // bandwidth; four minutes keeps it inside the presigned url's five-minute life.
    staleTime: 4 * 60_000,
    gcTime: 4 * 60_000,
    queryFn: ({ signal }) => fetchBinary(`/nodes/${nodeId}/content`, { signal }),
  })
}

/**
 * The bytes as something an iframe can render. Shared by the owner's viewer and the
 * guest's, because both must go through `fetchBinary`: an iframe pointed straight at
 * `/nodes/:id/content` carries neither the bearer nor the share token, and the blob's
 * type has to be ours rather than the bucket's (see `fetchBinary`).
 */
export function useDocumentObjectUrl(nodeId: string) {
  const content = useFileContent(nodeId)

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
