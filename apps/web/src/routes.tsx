import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { LoginPage } from './auth/LoginPage'
import { RegisterPage } from './auth/RegisterPage'
import { GoogleCallbackPage } from './auth/GoogleCallbackPage'
import { RequireAuth } from './auth/RequireAuth'
import { RoomPage } from './browser/RoomPage'
import { DashboardPage } from './rooms/DashboardPage'
import { Skeleton } from './components/Skeleton'

/**
 * Split out of the main bundle: the viewer is only reached from a file row, and nobody
 * signing in to browse folders should pay for it on first paint.
 */
const FileViewerPage = lazy(() =>
  import('./files/FileViewerPage').then((module) => ({ default: module.FileViewerPage })),
)

const viewerFallback = <Skeleton className="m-6 h-[70vh]" />

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/auth/callback" element={<GoogleCallbackPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <DashboardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/rooms/:roomId"
        element={
          <RequireAuth>
            <RoomPage />
          </RequireAuth>
        }
      />
      <Route
        path="/rooms/:roomId/f/:nodeId"
        element={
          <RequireAuth>
            <RoomPage />
          </RequireAuth>
        }
      />
      <Route
        path="/rooms/:roomId/file/:nodeId"
        element={
          <RequireAuth>
            <Suspense fallback={viewerFallback}>
              <FileViewerPage />
            </Suspense>
          </RequireAuth>
        }
      />
    </Routes>
  )
}
