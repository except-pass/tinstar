import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReleaseCanvas, ReleaseDetail } from '../../src/releases/Releases'
import { objectFixture, changeFixture } from './objects'

/** Standalone composition proof; bundle to a scratch directory, never ship as an app route. */
const titles = ['Bound RA query load and preserve downstream failures', 'Hide generator frequency when no generator is detected', 'Preserve Keystone Controller identity', 'Map Obol administrative event permissions', 'Correct Avalon Modbus enum writes', 'Remove expired RA arbiter history safely']
const changes = ['Passed', 'Passed', 'Running', 'Human review', 'Failed', 'Unknown'].map((status, index) => ({ ...changeFixture(index, status as Parameters<typeof changeFixture>[1]), title: titles[index]!,
  delivery: index === 5 ? 'Not deployed' as const : 'Deployed' as const,
  acceptanceEvidence: status === 'Failed' ? 'SYNTHETIC FIXTURE · 2 of 6 assertions failed' : status === 'Human review' ? 'SYNTHETIC FIXTURE · named reviewer must record the result' : status === 'Passed' ? 'SYNTHETIC FIXTURE · passed assertions' : null,
  note: ['Improved reliability when energy telemetry queries are overloaded.', 'Generator frequency is no longer shown when a generator is not detected.', 'Keystone Controllers appear correctly in equipment inventory.', 'Improved administrative authorization event handling.', 'Corrected Avalon configuration mappings.', 'Improved arbiter retention.'][index]! }))
const targets = ['ra-telemetry', 'web-fmp-portal', 'guardian-api', 'utility-obol', 'manager-siteconfiguration', 'ra-workflow'].map((component, index) => ({
  component, target: `fixture-only/${component}`, readiness: 'Ready', readinessEvidence: [],
  receipt: index === 5 ? null : { id: `fixture-receipt-${index}`, repository: 'owner/repo', environment: 'production', target: `fixture-only/${component}`, component,
    deployedSha: 'a'.repeat(40), artifactDigest: null, version: 'v1.24.0', deployedAt: '2026-11-10T12:00:00Z', outcome: 'succeeded' as const, exceptions: [], receiptUrl: 'https://example.com/fixture-receipt', workflowUrl: 'https://example.com/fixture-run' } }))
for (const [index, change] of changes.entries()) change.targets = [targets[index]!]
function Preview() {
  const [tab, setTab] = useState<'changes' | 'acceptance' | 'notes'>('acceptance')
  const [audience, setAudience] = useState<'internal' | 'customer'>('internal')
  const [drawer, setDrawer] = useState<string | null>(null)
  const release = { ...objectFixture('production'), targets, state: 'Partial rollout', gaps: ['SYNTHETIC FIXTURE · composition proof only; no live source or production claim'] }
  return <div style={{ display: 'flex', minHeight: '100vh', background: '#071116' }}><nav aria-label="Fixture global rail" style={{ width: 54, flex: 'none', background: '#060c10', borderRight: '1px solid #182d35' }} /><section className="rel-v3"><header className="main-top"><h1>Releases</h1><span className="prototype">SYNTHETIC FIXTURE · NO PROD CLAIMS</span></header><nav className="lane-tabs"><button type="button" className="lane-tab" onClick={() => setTab('changes')}>Plan</button><button type="button" className="lane-tab active" onClick={() => setTab('acceptance')}>Verify</button></nav><div className="body-layout"><aside className="releases-rail"><p className="rail-head">Production releases</p><div className="release-picker"><button type="button" className="pick active"><span className="pick-version">v1.24.0</span><span className="pick-detail">Partial · checks outstanding</span><span className="pick-meta">Fixture only</span></button></div></aside><ReleaseCanvas release={release} changes={changes} tab={tab} setTab={setTab} audience={audience} setAudience={setAudience} open={setDrawer} /></div>{drawer && <ReleaseDetail release={release} change={changes.find(change => change.id === drawer)} close={() => setDrawer(null)} />}</section></div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
