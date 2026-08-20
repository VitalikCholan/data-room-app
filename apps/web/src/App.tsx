import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AuthProvider } from './auth/AuthProvider'
import { AppRoutes } from './routes'
import { ConflictDialog } from './uploads/ConflictDialog'
import { UploadQueuePanel } from './uploads/UploadQueuePanel'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // 404/403/410 are answers, not failures — retrying them just delays the message.
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status
        if (status && status < 500) return false
        return failureCount < 2
      },
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
          {/*
            Outside the routes, like the store itself: an upload started in one folder
            keeps running — and keeps its panel and its one conflict prompt — while the
            user navigates anywhere else.
          */}
          <UploadQueuePanel />
          <ConflictDialog />
          <Toaster position="bottom-right" richColors />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
