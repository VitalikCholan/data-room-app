import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AccessContextProvider } from '../access/AccessProvider'
import { BrowserToolbar } from './BrowserToolbar'

function renderToolbar(role: 'OWNER' | 'VIEWER') {
  const onCreateFolder = vi.fn()
  const onPickFiles = vi.fn()
  render(
    <AccessContextProvider value={{ role, scopeRootId: 'root', isOwner: role === 'OWNER' }}>
      <BrowserToolbar sort="name" onSortChange={vi.fn()} onCreateFolder={onCreateFolder} onPickFiles={onPickFiles} />
    </AccessContextProvider>,
  )
  return { onCreateFolder, onPickFiles }
}

describe('BrowserToolbar', () => {
  it('offers folder creation and upload to an owner', () => {
    renderToolbar('OWNER')
    expect(screen.getByRole('button', { name: /New folder/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Upload/i })).toBeTruthy()
  })

  it('renders no mutation control at all for a viewer', () => {
    renderToolbar('VIEWER')
    expect(screen.queryByRole('button', { name: /New folder/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Upload/i })).toBeNull()
    // Sorting is a read, so it stays.
    expect(screen.getByLabelText(/Sort by/i)).toBeTruthy()
  })
})
