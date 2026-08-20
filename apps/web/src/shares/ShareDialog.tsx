import { Copy } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { OwnerOnly } from '../access/OwnerOnly'
import { ApiError } from '../api/client'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { ShareList } from './ShareList'
import { useCreateShare, useRevokeShare, useShares } from './hooks'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type ShareDialogProps = {
  nodeId: string
  nodeName: string
  nodeType: 'FOLDER' | 'FILE'
  /** Set when the shared folder is the room's own root, which reads better as the room. */
  isWholeRoom?: boolean
  onClose: () => void
}

/**
 * Sharing is an owner-only act, so the gate is the same `OwnerOnly` every other mutation
 * control uses — and it wraps the body rather than living inside it, so a viewer never
 * even mounts the component that would ask the server for the share list.
 */
export function ShareDialog(props: ShareDialogProps) {
  return (
    <OwnerOnly>
      <ShareDialogBody {...props} />
    </OwnerOnly>
  )
}

function ShareDialogBody({
  nodeId,
  nodeName,
  nodeType,
  isWholeRoom = false,
  onClose,
}: ShareDialogProps) {
  const shares = useShares(nodeId)
  const create = useCreateShare(nodeId)
  const revoke = useRevokeShare(nodeId)
  const [freshUrl, setFreshUrl] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)

  const subject = isWholeRoom
    ? 'this Data Room'
    : `${nodeType === 'FOLDER' ? 'folder' : 'file'} "${nodeName}"`

  /** 404, 409 and 410 all arrive with a sentence the API wrote. It is always better than ours. */
  const explain = (err: unknown, fallback: string) =>
    setError(err instanceof ApiError ? err.message : fallback)

  async function createLink() {
    setError(null)
    try {
      const result = await create.mutateAsync({ mode: 'PUBLIC_LINK' })
      // The one moment this string exists in the client. It is kept in state — never in
      // the query cache — because the cache is refetchable and this value is not.
      setFreshUrl(result.url ?? null)
    } catch (err) {
      explain(err, 'Could not create the link')
    }
  }

  async function invite() {
    const address = email.trim().toLowerCase()
    if (!EMAIL.test(address)) {
      setError('Enter a valid email address')
      return
    }
    setError(null)
    try {
      await create.mutateAsync({ mode: 'USER', email: address })
      setEmail('')
      toast.success('Invitation added')
    } catch (err) {
      explain(err, 'Could not invite that address')
    }
  }

  const copyLink = useCallback(async () => {
    if (!freshUrl) return
    try {
      await navigator.clipboard.writeText(freshUrl)
      toast.success('Link copied')
    } catch {
      // A denied clipboard permission or an insecure origin. The link is still on
      // screen, so say what to do instead of failing silently.
      setError('Could not reach the clipboard — select the link and copy it manually')
    }
  }, [freshUrl])

  const revokeShare = useCallback(
    (shareId: string) => {
      setError(null)
      revoke
        .mutateAsync(shareId)
        .catch((err: unknown) => explain(err, 'Could not revoke that access'))
    },
    [revoke],
  )

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={`Share ${subject}`}
      description="Recipients get read-only access to this item and everything inside it."
      // Radix would focus the close button; the dialog's own purpose is the first action.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        createButtonRef.current?.focus()
      }}
    >
      <Tabs defaultValue="link">
        <TabsList>
          <TabsTrigger value="link">Link</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
        </TabsList>

        <TabsContent value="link" className="flex flex-col gap-3">
          {freshUrl ? (
            <div className="flex flex-col gap-1">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={freshUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button variant="primary" className="shrink-0" onClick={() => void copyLink()}>
                  <Copy size={14} /> Copy
                </Button>
              </div>
              <p className="text-xs text-subtle">
                This link is shown once — you will not see it again. If you lose it, revoke it here
                and create another.
              </p>
            </div>
          ) : (
            <Button
              ref={createButtonRef}
              variant="primary"
              disabled={create.isPending}
              onClick={() => void createLink()}
            >
              {create.isPending ? 'Creating…' : 'Create link'}
            </Button>
          )}

          {shares.data ? (
            <ShareList
              shares={shares.data}
              mode="PUBLIC_LINK"
              revoking={revoke.isPending}
              onRevoke={revokeShare}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="people" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="share-email">
              Email
            </label>
            <div className="flex gap-2">
              <Input
                id="share-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="counsel@example.com"
              />
              <Button
                variant="primary"
                className="shrink-0"
                disabled={create.isPending}
                onClick={() => void invite()}
              >
                Invite
              </Button>
            </div>
            <p className="text-xs text-subtle">
              They do not need an account yet — access starts the moment they register with this
              address.
            </p>
          </div>

          {shares.data ? (
            <ShareList
              shares={shares.data}
              mode="USER"
              revoking={revoke.isPending}
              onRevoke={revokeShare}
            />
          ) : null}
        </TabsContent>
      </Tabs>

      {shares.isError ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {shares.error instanceof ApiError
            ? shares.error.message
            : 'Could not load who has access'}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
