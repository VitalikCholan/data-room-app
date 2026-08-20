/**
 * A node's `path` holds its ancestors' ids, root first, each delimited and
 * terminated by '/'. A root node's path is exactly '/'.
 *
 *   root        -> "/"
 *   root/fin    -> "/{rootId}/"
 *   root/fin/q4 -> "/{rootId}/{finId}/"
 *
 * The trailing slash is what makes prefix matching safe: ids are fixed length and
 * the delimiter closes the prefix, so "/a/ab/" can never match "/a/abc/".
 */
export const ROOT_PATH = '/'

export function childPath(parent: { id: string; path: string }): string {
  return `${parent.path}${parent.id}/`
}

export function ancestorIds(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function depth(path: string): number {
  return ancestorIds(path).length
}

/** True when `node` is the subtree root itself or lives anywhere beneath it. */
export function isWithinSubtree(
  node: { id: string; path: string },
  subtreeRootId: string,
  subtreeRootPath: string,
): boolean {
  if (node.id === subtreeRootId) return true
  return node.path.startsWith(`${subtreeRootPath}${subtreeRootId}/`)
}

/** SQL LIKE pattern matching every descendant of the given node. */
export function subtreeLikePattern(node: { id: string; path: string }): string {
  return `${childPath(node)}%`
}
