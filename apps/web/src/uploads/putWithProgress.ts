/**
 * The one request in this app that is not made by `src/api/client.ts`, deliberately
 * isolated here: its target is the object bucket, not our API. It carries no session
 * — the presigned url is the whole credential — and adding it to the api client would
 * mean the client sending our Authorization header to a third-party host.
 *
 * XMLHttpRequest rather than fetch: `upload.onprogress` reports bytes actually sent.
 * fetch has no portable upload-progress signal, and a bar that only knows "sent" and
 * "done" is worse than none for a 50 MB PDF.
 */
export function putWithProgress(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Checked before the request is opened: `addEventListener('abort')` never fires on a
    // signal that is already aborted, so without this a cancel made while the presign was
    // still in flight would be dropped on the floor and the file would upload anyway.
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }

    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url, true)
    // The presign was signed for this exact content type; anything else is rejected
    // by the bucket, not by us.
    xhr.setRequestHeader('Content-Type', 'application/pdf')

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed with status ${xhr.status}`))
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))

    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(file)
  })
}
