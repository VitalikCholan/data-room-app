import type { ReactNode } from 'react'
import { useAccess } from '../access/AccessProvider'
import { EmptyState } from '../components/EmptyState'

export function NodeTableEmpty({ action }: { action?: ReactNode }) {
  const { isOwner } = useAccess()
  // A guest cannot create or upload, so the hint would only name actions it will
  // never be offered.
  return isOwner ? (
    <EmptyState title="This folder is empty" hint="Drop PDFs here or create a folder to get started." action={action} />
  ) : (
    <EmptyState title="This folder is empty" />
  )
}
