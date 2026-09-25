import { useState } from 'react'
import WorkspaceShell from './components/WorkspaceShell'
import { v6ShellEnabled } from './v6/shell/enabled'
import { V6Shell } from './v6/shell/V6Shell'

export default function App() {
  const [v6] = useState(() => v6ShellEnabled())
  if (v6) return <V6Shell />
  return <WorkspaceShell />
}
