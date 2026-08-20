import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { Breadcrumbs } from './Breadcrumbs'

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

  it('renders a single crumb without any link', () => {
    render(
      <MemoryRouter>
        <Breadcrumbs roomId="r1" crumbs={[crumbs[0]]} onDropOnCrumb={() => {}} />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link')).toBeNull()
  })
})
