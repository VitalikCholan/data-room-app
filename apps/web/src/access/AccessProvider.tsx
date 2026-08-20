/* eslint-disable react-refresh/only-export-components -- useAccess is the companion hook of this provider */
import { createContext, useContext, useMemo, type ReactNode } from 'react'

export type AccessRole = 'OWNER' | 'VIEWER'

export type AccessValue = {
  role: AccessRole
  scopeRootId: string | null
  isOwner: boolean
}

const AccessContext = createContext<AccessValue>({ role: 'OWNER', scopeRootId: null, isOwner: true })

/** Exported separately so tests can inject a role without a network round trip. */
export function AccessContextProvider({ value, children }: { value: AccessValue; children: ReactNode }) {
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
}

/**
 * The listing response carries role and scopeRootId, so the same components serve an
 * owner and a share recipient. Components read the role here rather than branching on
 * "am I a guest" in a dozen places.
 */
export function AccessProvider({
  role,
  scopeRootId,
  children,
}: {
  role: AccessRole
  scopeRootId: string | null
  children: ReactNode
}) {
  const value = useMemo<AccessValue>(() => ({ role, scopeRootId, isOwner: role === 'OWNER' }), [role, scopeRootId])
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
}

export const useAccess = () => useContext(AccessContext)
