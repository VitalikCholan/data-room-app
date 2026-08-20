import * as Primitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 bg-ink/30 backdrop-blur-[1px]" />
        <Primitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-panel',
            className,
          )}
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <Primitive.Title className="text-base font-semibold">{title}</Primitive.Title>
              {description ? (
                <Primitive.Description className="mt-1 text-sm text-subtle">{description}</Primitive.Description>
              ) : null}
            </div>
            <Primitive.Close aria-label="Close" className="rounded p-1 text-subtle hover:bg-muted hover:text-ink">
              <X size={16} />
            </Primitive.Close>
          </div>
          {children}
          {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  )
}
