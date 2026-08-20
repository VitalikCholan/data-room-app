/**
 * The MIME type a dragged row carries. Row-to-folder drag and OS file drop are separate
 * mechanisms that happen to use the same browser API, so every handler checks which one
 * it is looking at before claiming the event: rows carry this type, files carry 'Files'.
 */
export const NODE_DRAG_TYPE = 'application/x-node-id'
