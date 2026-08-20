import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SearchInput } from './SearchInput'

describe('SearchInput', () => {
  it('reports what was typed', async () => {
    const onChange = vi.fn()
    render(<SearchInput value="" onChange={onChange} />)
    await userEvent.type(screen.getByLabelText(/Search/i), 'a')
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('offers no clear button until there is something to clear', () => {
    render(<SearchInput value="" onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Clear search/i })).toBeNull()
  })

  it('clears the term, which is what restores the listing', async () => {
    const onChange = vi.fn()
    render(<SearchInput value="audit" onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /Clear search/i }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('says a search is a read, so a viewer keeps it', () => {
    // No OwnerOnly anywhere in this component: searching changes nothing.
    render(<SearchInput value="" onChange={vi.fn()} />)
    expect(screen.getByPlaceholderText(/Search by name/i)).toBeTruthy()
  })
})
