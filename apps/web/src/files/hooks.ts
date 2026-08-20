import { useQuery } from '@tanstack/react-query'
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
