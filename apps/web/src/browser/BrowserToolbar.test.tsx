import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AccessContextProvider } from '../access/AccessProvider'
import { BrowserToolbar } from './BrowserToolbar'

function renderToolbar(role: 'OWNER' | 'VIEWER') {
  const onCreateFolder = vi.fn()
  const onPickFiles = vi.fn()
  const onShare = vi.fn()
  render(
    <AccessContextProvider value={{ role, scopeRootId: 'root', isOwner: role === 'OWNER' }}>
      <BrowserToolbar
        sort="name"
        onSortChange={vi.fn()}
        onCreateFolder={onCreateFolder}
        onPickFiles={onPickFiles}
        onShare={onShare}
      />
    </AccessContextProvider>,
  )
  return { onCreateFolder, onPickFiles, onShare }
}

describe('BrowserToolbar', () => {
  it('offers folder creation and upload to an owner', () => {
    renderToolbar('OWNER')
    expect(screen.getByRole('button', { name: /New folder/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Upload/i })).toBeTruthy()
  })

  it('lets an owner share the folder on screen', async () => {
    const { onShare } = renderToolbar('OWNER')
    await userEvent.click(screen.getByRole('button', { name: /^Share$/i }))
    expect(onShare).toHaveBeenCalled()
  })

  it('renders no mutation control at all for a viewer', () => {
    renderToolbar('VIEWER')
    expect(screen.queryByRole('button', { name: /New folder/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Upload/i })).toBeNull()
    // Sharing hands out access, so it is an owner's control like any other.
    expect(screen.queryByRole('button', { name: /^Share$/i })).toBeNull()
    // Sorting is a read, so it stays.
    expect(screen.getByLabelText(/Sort by/i)).toBeTruthy()
  })
})
