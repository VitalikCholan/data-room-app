import { blobKeyFor } from './storage.service'

describe('blobKeyFor', () => {
  it('is derived from ids, never from a client-supplied filename', () => {
    expect(blobKeyFor('room-1', 'node-2', 3)).toBe(
      'rooms/room-1/nodes/node-2/v3',
    )
  })

  it('gives every version its own key so history is immutable', () => {
    expect(blobKeyFor('r', 'n', 1)).not.toBe(blobKeyFor('r', 'n', 2))
  })
})
