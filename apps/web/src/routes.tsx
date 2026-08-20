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

/**
 * Also split out: a guest never reaches the owner's screens, and an owner never reaches
 * this one, so neither should pay for the other on first paint.
 */
const GuestPage = lazy(() =>
  import('./guest/GuestPage').then((module) => ({ default: module.GuestPage })),
)

const viewerFallback = <Skeleton className="m-6 h-[70vh]" />

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/auth/callback" element={<GoogleCallbackPage />} />
      {/*
        Outside RequireAuth on purpose: the token in the url is the whole credential, and
        a public link that demanded a sign-in would not be a public link.
      */}
      <Route
        path="/s/:token"
        element={
          <Suspense fallback={viewerFallback}>
            <GuestPage />
          </Suspense>
        }
      />
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
