import { AppShell } from '../components/AppShell'
import { EmptyState } from '../components/EmptyState'

/** Placeholder until Task 20 delivers the real dashboard of Data Rooms. */
export function DashboardPage() {
  return (
    <AppShell>
      <EmptyState title="No Data Rooms yet" hint="The dashboard arrives in the next task." />
    </AppShell>
  )
}
