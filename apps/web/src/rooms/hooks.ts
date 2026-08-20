import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { queryKeys } from '../api/keys'

export type Room = {
  id: string
  name: string
  rootNodeId: string
  createdAt: string
  rollup: { folders: number; files: number; bytes: number }
}

export type SharedItem = {
  shareId: string
  roomId: string
  roomName: string
  nodeId: string
  nodeName: string
  nodeType: 'FOLDER' | 'FILE'
  isWholeRoom: boolean
}

export const useRooms = () =>
  useQuery({ queryKey: queryKeys.rooms.all, queryFn: () => api.get<Room[]>('/rooms') })

export const useSharedWithMe = () =>
  useQuery({
    queryKey: queryKeys.rooms.sharedWithMe,
    queryFn: () => api.get<SharedItem[]>('/rooms/shared-with-me'),
  })

export function useCreateRoom() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.post<Room>('/rooms', { name }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.rooms.all }),
  })
}

export function useRenameRoom() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<Room>(`/rooms/${id}`, { name }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.rooms.all }),
  })
}

export function useDeleteRoom() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.del<{ id: string }>(`/rooms/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.rooms.all }),
  })
}
