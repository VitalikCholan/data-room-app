/** One factory so an invalidation can never miss a key by typo. */
export const queryKeys = {
  session: ['session'] as const,
  rooms: {
    all: ['rooms'] as const,
    sharedWithMe: ['rooms', 'shared-with-me'] as const,
  },
  nodes: {
    list: (roomId: string, parentId: string | null, sort: string) =>
      ['nodes', roomId, parentId ?? 'root', sort] as const,
    rollup: (nodeId: string) => ['nodes', nodeId, 'rollup'] as const,
    deletionPreview: (nodeId: string) => ['nodes', nodeId, 'deletion-preview'] as const,
    versions: (nodeId: string) => ['nodes', nodeId, 'versions'] as const,
    shares: (nodeId: string) => ['nodes', nodeId, 'shares'] as const,
  },
  search: (roomId: string, q: string) => ['search', roomId, q] as const,
  sharedBootstrap: (token: string) => ['shared', token] as const,
}
