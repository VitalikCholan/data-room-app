/* eslint-disable react-refresh/only-export-components -- thin wrapper module re-exporting Radix parts */
import * as Primitive from '@radix-ui/react-tabs'
import type { ReactNode } from 'react'

export const Tabs = Primitive.Root

export function TabsList({ children }: { children: ReactNode }) {
  return (
    <Primitive.List className="mb-4 flex gap-1 rounded-md bg-muted p-1">{children}</Primitive.List>
  )
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Primitive.Trigger
      value={value}
      className="flex-1 rounded px-3 py-1.5 text-sm text-subtle data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-sm"
    >
      {children}
    </Primitive.Trigger>
  )
}

export const TabsContent = Primitive.Content
