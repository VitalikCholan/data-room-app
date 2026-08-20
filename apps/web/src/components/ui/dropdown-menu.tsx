/* eslint-disable react-refresh/only-export-components -- thin wrapper module re-exporting Radix parts */
import * as Primitive from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export const DropdownMenu = Primitive.Root
export const DropdownTrigger = Primitive.Trigger

export function DropdownContent({ children }: { children: ReactNode }) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align="end"
        sideOffset={4}
        className="min-w-44 rounded-md border border-border bg-surface p-1 shadow-panel"
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  )
}

export function DropdownItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <Primitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-40',
        danger && 'text-danger',
      )}
    >
      {children}
    </Primitive.Item>
  )
}

export const DropdownSeparator = () => <Primitive.Separator className="my-1 h-px bg-border" />
