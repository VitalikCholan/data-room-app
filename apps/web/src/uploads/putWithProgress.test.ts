import { afterEach, describe, expect, it, vi } from 'vitest'
import { putWithProgress } from './putWithProgress'

const pdf = () => new File([new Uint8Array(16)], 'a.pdf', { type: 'application/pdf' })

/** Enough of XMLHttpRequest to see whether a request was ever made. */
function stubXhr() {
  const calls = { open: vi.fn(), send: vi.fn(), setRequestHeader: vi.fn() }
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      upload = {}
      open = calls.open
      send = calls.send
      setRequestHeader = calls.setRequestHeader
      abort = vi.fn()
      status = 200
    },
  )
  return calls
}

describe('putWithProgress', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('refuses a signal that is already aborted, without sending anything', async () => {
    const calls = stubXhr()
    const controller = new AbortController()
    controller.abort()

    // `addEventListener('abort')` never fires on an already-aborted signal, so a cancel
    // made while the presign was still in flight used to be silently dropped and the
    // file uploaded anyway.
    await expect(putWithProgress('https://bucket.test/put', pdf(), () => {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(calls.open).not.toHaveBeenCalled()
    expect(calls.send).not.toHaveBeenCalled()
  })
})
