/** One factory so an invalidation can never miss a key by typo. */
export const queryKeys = {
  session: ['session'] as const,
  rooms: {
    all: ['rooms'] as const,
    sharedWithMe: ['rooms', 'shared-with-me'] as const,
  },
  nodes: {
    /** Prefix of every listing in one room: a move changes two folders, so both must go stale. */
    roomLists: (roomId: string) => ['nodes', roomId] as const,
    list: (roomId: string, parentId: string | null, sort: string) =>
      ['nodes', roomId, parentId ?? 'root', sort] as const,
    /**
     * The move picker's own key. It shares the `['nodes', roomId]` prefix so a move
     * invalidates it, but never collides with a `list` key: 'folder-children' is not
     * a sort mode.
     */
    folderChildren: (roomId: string, parentId: string) => ['nodes', roomId, parentId, 'folder-children'] as const,
    rollup: (nodeId: string) => ['nodes', nodeId, 'rollup'] as const,
    deletionPreview: (nodeId: string) => ['nodes', nodeId, 'deletion-preview'] as const,
    versions: (nodeId: string) => ['nodes', nodeId, 'versions'] as const,
    shares: (nodeId: string) => ['nodes', nodeId, 'shares'] as const,
  },
  search: (roomId: string, q: string) => ['search', roomId, q] as const,
  sharedBootstrap: (token: string) => ['shared', token] as const,
}
