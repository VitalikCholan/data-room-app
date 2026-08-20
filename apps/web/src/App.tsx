import { useEffect, useState } from 'react'

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '/api'

// Placeholder shell: its only job is to prove the /api rewrite reaches the
// backend. Replaced by the real app in Task 19.
export default function App() {
  const [status, setStatus] = useState('checking…')

  useEffect(() => {
    fetch(`${API_BASE_URL}/health`)
      .then((res) => res.json() as Promise<{ status: string }>)
      .then((body) => setStatus(body.status))
      .catch((err: unknown) => setStatus(`error: ${String(err)}`))
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem' }}>
      <h1>Data Room</h1>
      <p>api: {status}</p>
    </main>
  )
}
