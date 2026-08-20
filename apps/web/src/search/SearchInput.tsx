import { Search, X } from 'lucide-react'
import { useCallback, type ChangeEvent } from 'react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'

/**
 * Presentational, and deliberately outside `OwnerOnly`: searching reads, so a share
 * recipient keeps it. What they may find is the API's business, not this input's.
 */
export function SearchInput({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange],
  )
  const clear = useCallback(() => onChange(''), [onChange])

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Search size={14} className="shrink-0 text-subtle" aria-hidden />
      <label className="sr-only" htmlFor="node-search">
        Search by name
      </label>
      <Input
        id="node-search"
        type="search"
        value={value}
        placeholder="Search by name…"
        onChange={handleChange}
        className="h-8 w-40 sm:w-64"
      />
      {value ? (
        <Button size="icon" variant="ghost" aria-label="Clear search" onClick={clear}>
          <X size={14} />
        </Button>
      ) : null}
    </div>
  )
}
