/** One factory so an invalidation can never miss a key by typo. */
export const queryKeys = {
  session: ['session'] as const,
  rooms: {
    all: ['rooms'] as const,
    sharedWithMe: ['rooms', 'shared-with-me'] as const,
  },
  nodes: {
    /**
     * Every node-scoped entry, whatever the room. Used for eviction rather than
     * invalidation: leaving a share route changes *who* the client is, so everything
     * fetched under the old identity has to go rather than be refreshed in place.
     */
    all: ['nodes'] as const,
    /** Prefix of every listing in one room: a move changes two folders, so both must go stale. */
    roomLists: (roomId: string) => ['nodes', roomId] as const,
    list: (roomId: string, parentId: string | null, sort: string) =>
      ['nodes', roomId, parentId ?? 'root', sort] as const,
    /**
     * The move picker's own key. It shares the `['nodes', roomId]` prefix so a move
     * invalidates it, but never collides with a `list` key: 'folder-children' is not
     * a sort mode.
     */
    folderChildren: (roomId: string, parentId: string) =>
      ['nodes', roomId, parentId, 'folder-children'] as const,
    rollup: (nodeId: string) => ['nodes', nodeId, 'rollup'] as const,
    deletionPreview: (nodeId: string) => ['nodes', nodeId, 'deletion-preview'] as const,
    /**
     * The viewer's document bytes. Short-lived: the presigned GET behind it lives 5
     * minutes. Keyed on the version too, so reading an older one does not evict the
     * current bytes and going back to them is free.
     */
    content: (nodeId: string, versionId: string | null = null) =>
      ['nodes', nodeId, 'content', versionId ?? 'current'] as const,
    /** Every version's bytes for one file: what a restore makes stale in one stroke. */
    contentAll: (nodeId: string) => ['nodes', nodeId, 'content'] as const,
    versions: (nodeId: string) => ['nodes', nodeId, 'versions'] as const,
    shares: (nodeId: string) => ['nodes', nodeId, 'shares'] as const,
  },
  /**
   * Search results are node reads under another name, so they are evicted — not
   * refreshed — when the caller's identity changes (see `useShareSession`). The scope
   * parent is part of the key because the same term answers differently inside a share
   * than it does across the whole room.
   */
  search: {
    all: ['search'] as const,
    results: (roomId: string, scopeParentId: string | null, q: string) =>
      ['search', roomId, scopeParentId ?? 'room', q] as const,
  },
  sharedBootstrap: (token: string) => ['shared', token] as const,
}
