import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { Breadcrumbs } from './Breadcrumbs'
import { AccessContextProvider } from '../access/AccessProvider'

const nodeDrag = (sourceId: string) => ({
  dataTransfer: { types: ['application/x-node-id'], getData: () => sourceId, dropEffect: 'none' },
})

describe('Breadcrumbs', () => {
  const crumbs = [
    { id: 'root', name: 'Project Titan', type: 'FOLDER' as const },
    { id: 'legal', name: 'Legal', type: 'FOLDER' as const },
    { id: 'contracts', name: 'Contracts', type: 'FOLDER' as const },
  ]

  it('links every ancestor but not the current folder', () => {
    render(
      <MemoryRouter>
        <Breadcrumbs roomId="r1" crumbs={crumbs} onDropOnCrumb={() => {}} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Legal' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Contracts' })).toBeNull()
    expect(screen.getByText('Contracts')).toBeTruthy()
  })

  it('moves a dropped row into the crumb it was dropped on', () => {
    const onDropOnCrumb = vi.fn()
    render(
      <MemoryRouter>
        <Breadcrumbs roomId="r1" crumbs={crumbs} onDropOnCrumb={onDropOnCrumb} />
      </MemoryRouter>,
    )
    fireEvent.drop(screen.getByRole('link', { name: 'Legal' }), nodeDrag('doc'))
    expect(onDropOnCrumb).toHaveBeenCalledWith('legal', 'doc')
  })

  it('ignores an OS file drop on a crumb', () => {
    const onDropOnCrumb = vi.fn()
    render(
      <MemoryRouter>
        <Breadcrumbs roomId="r1" crumbs={crumbs} onDropOnCrumb={onDropOnCrumb} />
      </MemoryRouter>,
    )
    fireEvent.drop(screen.getByRole('link', { name: 'Legal' }), { dataTransfer: { types: ['Files'], getData: () => '' } })
    expect(onDropOnCrumb).not.toHaveBeenCalled()
  })

  it('never accepts a drop from a viewer', () => {
    const onDropOnCrumb = vi.fn()
    render(
      <MemoryRouter>
        <AccessContextProvider value={{ role: 'VIEWER', scopeRootId: 'root', isOwner: false }}>
          <Breadcrumbs roomId="r1" crumbs={crumbs} onDropOnCrumb={onDropOnCrumb} />
        </AccessContextProvider>
      </MemoryRouter>,
    )
    // A viewer's rows are not draggable, so this drag cannot come from the UI — which is
    // exactly why the crumb has to check for itself.
    fireEvent.drop(screen.getByRole('link', { name: 'Legal' }), nodeDrag('doc'))
    expect(onDropOnCrumb).not.toHaveBeenCalled()
  })

  it('renders a single crumb without any link', () => {
    render(
      <MemoryRouter>
        <Breadcrumbs roomId="r1" crumbs={[crumbs[0]]} onDropOnCrumb={() => {}} />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link')).toBeNull()
  })
})
