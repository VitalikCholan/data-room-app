import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-border bg-surface px-3 text-sm outline-none placeholder:text-subtle focus:border-accent',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
