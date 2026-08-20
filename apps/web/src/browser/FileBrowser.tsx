import type { ReactNode } from 'react'
import { Breadcrumbs } from './Breadcrumbs'
import type { Crumb } from './hooks/useNodeList'

/** Layout only. It fetches nothing, so it can be reused by the guest route unchanged. */
export function FileBrowser({
  roomId,
  crumbs,
  toolbar,
  children,
  onDropOnCrumb,
  footer,
}: {
  roomId: string
  crumbs: Crumb[]
  toolbar: ReactNode
  children: ReactNode
  onDropOnCrumb: (folderId: string, sourceId: string) => void
  footer?: ReactNode
}) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Breadcrumbs roomId={roomId} crumbs={crumbs} onDropOnCrumb={onDropOnCrumb} />
      </div>
      {toolbar}
      {children}
      {footer}
    </section>
  )
}
