import { cn } from '../lib/cn'

export const Skeleton = ({ className }: { className?: string }) => (
  <div className={cn('animate-pulse rounded bg-border/60', className)} />
)

/** Rows, not a spinner: the table keeps its height so nothing jumps on load. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 flex-1 max-w-[18rem]" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  )
}
