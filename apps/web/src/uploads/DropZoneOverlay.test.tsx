import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DropZoneOverlay } from './DropZoneOverlay'

const fileDrag = (files: File[]) => ({ dataTransfer: { types: ['Files'], files } })
const rowDrag = { dataTransfer: { types: ['application/x-node-id'], files: [] } }

describe('DropZoneOverlay', () => {
  it('hands every dropped file to the queue', () => {
    const onFiles = vi.fn()
    render(
      <DropZoneOverlay onFiles={onFiles}>
        <p>listing</p>
      </DropZoneOverlay>,
    )
    const files = [new File(['a'], 'a.pdf', { type: 'application/pdf' })]
    fireEvent.drop(screen.getByText('listing'), fileDrag(files))
    expect(onFiles).toHaveBeenCalledWith(files)
  })

  it('shows the prompt while files are over the listing and hides it after the drop', () => {
    render(
      <DropZoneOverlay onFiles={vi.fn()}>
        <p>listing</p>
      </DropZoneOverlay>,
    )
    const target = screen.getByText('listing')
    fireEvent.dragEnter(target, fileDrag([]))
    expect(screen.getByText(/Drop PDFs here/i)).toBeTruthy()
    fireEvent.drop(target, fileDrag([]))
    expect(screen.queryByText(/Drop PDFs here/i)).toBeNull()
  })

  it('keeps the prompt up while the pointer crosses child elements', () => {
    render(
      <DropZoneOverlay onFiles={vi.fn()}>
        <p>listing</p>
      </DropZoneOverlay>,
    )
    const target = screen.getByText('listing')
    fireEvent.dragEnter(target, fileDrag([]))
    fireEvent.dragEnter(target, fileDrag([]))
    fireEvent.dragLeave(target, fileDrag([]))
    expect(screen.getByText(/Drop PDFs here/i)).toBeTruthy()
  })

  it('ignores a dragged row: that is a move, not an upload', () => {
    const onFiles = vi.fn()
    render(
      <DropZoneOverlay onFiles={onFiles}>
        <p>listing</p>
      </DropZoneOverlay>,
    )
    const target = screen.getByText('listing')
    fireEvent.dragEnter(target, rowDrag)
    expect(screen.queryByText(/Drop PDFs here/i)).toBeNull()
    fireEvent.drop(target, rowDrag)
    expect(onFiles).not.toHaveBeenCalled()
  })
})
