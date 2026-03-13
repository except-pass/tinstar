import WorkspaceShell from './components/WorkspaceShell'
import { SkillsProvider } from './components/SkillsProvider'

export default function App() {
  return (
    <SkillsProvider>
      <WorkspaceShell />
    </SkillsProvider>
  )
}
