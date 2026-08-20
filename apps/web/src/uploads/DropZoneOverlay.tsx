import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react'

/** An OS file drag advertises this; a dragged row advertises its own node-id type. */
const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes('Files')

/**
 * OS file drop, which shares nothing with row-to-folder drag but the browser API.
 *
 * dragenter/dragleave are counted rather than toggled: without the counter the prompt
 * flickers every time the pointer crosses a child element. OS folders are not
 * supported, and the copy says PDFs rather than implying otherwise.
 */
export function DropZoneOverlay({ onFiles, children }: { onFiles: (files: File[]) => void; children: ReactNode }) {
  const [isOver, setIsOver] = useState(false)
  const depth = useRef(0)

  const onDragEnter = useCallback((event: DragEvent) => {
    if (!isFileDrag(event)) return
    depth.current += 1
    setIsOver(true)
  }, [])

  const onDragLeave = useCallback((event: DragEvent) => {
    if (!isFileDrag(event)) return
    depth.current -= 1
    if (depth.current <= 0) {
      depth.current = 0
      setIsOver(false)
    }
  }, [])

  // Both handlers below must call preventDefault to claim the drop, so neither can be
  // registered passively — React attaches them itself in any case.
  const onDragOver = useCallback((event: DragEvent) => {
    if (isFileDrag(event)) event.preventDefault()
  }, [])

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      depth.current = 0
      setIsOver(false)
      onFiles(Array.from(event.dataTransfer.files))
    },
    [onFiles],
  )

  return (
    <div className="relative" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
      {children}
      {isOver ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/5">
          <p className="rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-panel">Drop PDFs here</p>
        </div>
      ) : null}
    </div>
  )
}
