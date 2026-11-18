import { clean, pairKey, type Destination } from './catalog'
import { assess, thresholds, type Threshold } from './classify'
import { jevModel } from './openRouter'
import type { DryRun, DryRunRow } from './service'

const pct = (part: number, total: number) => total ? `${(100 * part / total).toFixed(1)}%` : '—'
const display = (destination: Destination) => `${clean(destination.initiative, 100)} / ${clean(destination.epic, 100) || '(initiative only)'}`
const cell = (text: string) => text.replace(/[|<>]/g, character => ({ '|': '\\|', '<': '&lt;', '>': '&gt;' })[character]!)
const table = (headers: string[], rows: (string | number)[][]) =>
  [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(value => cell(String(value))).join(' | ')} |`).join('\n')
const cohortRows = (report: DryRun, cohort: DryRunRow['cohort']) => report.rows.filter(row => row.cohort === cohort)
function distribution(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}
const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? '—'

function evaluate(rows: DryRunRow[], threshold: Threshold, known: Set<string>) {
  let correct = 0, novel = 0, detected = 0, falseAcceptedNovel = 0
  const errors: { truth: Destination; proposed: Destination; cardId: string }[] = []
  for (const { expected, result } of rows) {
    if (!expected) continue
    const actual = assess(result, threshold)
    const inCatalog = known.has(pairKey(expected.initiative, expected.epic))
    if (!inCatalog) {
      novel++
      if (actual.outcome === 'needs-review' && ['initiative-no-fit', 'epic-no-fit', 'no-existing-initiative'].includes(actual.reason)) detected++
      if (actual.outcome === 'candidate') falseAcceptedNovel++
    }
    if (actual.outcome !== 'candidate') continue
    if (actual.destination.initiative === expected.initiative && actual.destination.epic === expected.epic) correct++
    else errors.push({ truth: expected, proposed: actual.destination, cardId: result.cardId })
  }
  const accepted = correct + errors.length
  const precision = accepted ? correct / accepted : 0
  // Wilson one-sided 95% lower bound. Report it alongside observed precision
  // so a handful of perfect matches does not read as a proven 95% policy.
  const z = 1.644854
  const lower = accepted ? (precision + z ** 2 / (2 * accepted) -
    z * Math.sqrt(precision * (1 - precision) / accepted + z ** 2 / (4 * accepted ** 2))) / (1 + z ** 2 / accepted) : 0
  return { correct, accepted, lower, novel, detected, falseAcceptedNovel, errors }
}

export function dryRunReport(report: DryRun, notion: { requests: Record<string, number>; rateLimits: number }) {
  const calibration = cohortRows(report, 'calibration'), holdout = cohortRows(report, 'holdout')
  const unassigned = cohortRows(report, 'unassigned')
  const known = new Set(report.catalog.pairs.map(pair => pairKey(pair.initiative, pair.epic)))
  const evaluations = Object.entries(thresholds).map(([name, threshold]) => ({
    name, threshold, calibration: evaluate(calibration, threshold, known), holdout: evaluate(holdout, threshold, known),
  }))
  // Select by calibration coverage only. The holdout is used once to report
  // whether that choice generalizes, never to shop for a different threshold.
  const chosen = evaluations.filter(value => value.calibration.accepted && value.calibration.correct / value.calibration.accepted >= 0.95)
    .sort((a, b) => b.calibration.accepted - a.calibration.accepted)[0]
  const policy = chosen ?? evaluations.find(value => value.name === 'conservative')!
  const accepted = chosen?.holdout.accepted ?? 0
  const observedPass = chosen && accepted > 0 && chosen.holdout.correct / accepted >= 0.95
  const recommendation = observedPass
    ? `The **${chosen.name}** profile reached ${pct(chosen.holdout.correct, accepted)} observed holdout precision (${chosen.holdout.correct}/${accepted}), with a ${pct(chosen.holdout.lower, 1)} one-sided 95% lower bound. This is a provisional threshold for an independent human audit.`
    : 'No threshold met 95% on calibration and the untouched holdout with a nonempty accepted set. Keep automatic writes disabled.'
  const all = report.rows
  function timings(rows: DryRunRow[]) {
    const calls = rows.flatMap(({ result }) => result.state === 'examined' ? [result.telemetry] : [])
    const usage = calls.flatMap(call => call.usage ? [call.usage] : [])
    const costs = usage.flatMap(row => row.cost == null ? [] : [row.cost])
    return [rows.length, calls.length, percentile(calls.map(call => call.latencyMs), 0.5), percentile(calls.map(call => call.latencyMs), 0.95),
      percentile(rows.map(row => row.result.wallMs), 0.5), percentile(rows.map(row => row.result.wallMs), 0.95),
      calls.reduce((sum, call) => sum + call.attempts - 1, 0), usage.reduce((sum, row) => sum + row.input_tokens, 0),
      usage.reduce((sum, row) => sum + row.output_tokens, 0),
      costs.length ? costs.reduce((sum, cost) => sum + cost, 0).toFixed(7) : '—', costs.length]
  }
  const confusion = distribution([...calibration, ...holdout].map(({ expected, result }) => {
    const actual = assess(result, policy.threshold)
    return JSON.stringify([display(expected!), actual.outcome === 'candidate' ? display(actual.destination) : `(${actual.outcome})`])
  })).map(([encoded, count]) => [...JSON.parse(encoded) as [string, string], count])
  const reasons = (rows: DryRunRow[]) => distribution(rows.map(({ result }) => {
    const value = assess(result, policy.threshold)
    return value.outcome === 'candidate' ? value.outcome : `${value.outcome} · ${value.reason}`
  }))
  return [
    '# Tin Star Jev dry run',
    `Batch \`${report.batchId}\`, catalog \`${report.catalog.revision}\`, requested model \`${jevModel}\`. Served response versions: ${[...new Set(all.flatMap(({ result }) => result.state === 'examined' ? [result.telemetry.model] : []))].join(', ') || 'none'}.`,
    `Live board had ${report.activeCards} active cards, ${unassigned.length} with Initiative missing, ${report.catalog.initiativeOptions.length} Initiative options and ${report.catalog.epicOptions.length} Epic options. Destinations came from ${report.catalog.initiatives.length} open initiatives and ${known.size} active pairs or explicitly allowed initiative-only destinations.`,
    `Historical replay used ${calibration.length + holdout.length} of ${report.historicalCards} closed cards with both Notion selects populated. The target labels were hidden from Jev. Active cards supplied example titles. We filtered exact target-title matches from examples. Historical selections are reference labels. Their accuracy and the unassigned cards require independent human adjudication before any write rollout.`,
    '## Threshold calibration',
    recommendation,
    table(['Profile', 'Min choice', 'Min margin', 'Min fit', 'Max ambiguity', 'Calibration correct / accepted', 'Holdout correct / accepted', 'Holdout precision', 'Holdout lower bound'], evaluations.map(value => [
      value.name, value.threshold.choice, value.threshold.margin, value.threshold.fit, value.threshold.ambiguity,
      `${value.calibration.correct} / ${value.calibration.accepted}`, `${value.holdout.correct} / ${value.holdout.accepted}`,
      pct(value.holdout.correct, value.holdout.accepted), value.holdout.accepted ? pct(value.holdout.lower, 1) : '—',
    ])),
    `Detailed results use the **${policy.name}** profile. The ledger records a separate conservative baseline assessment. Calibration and holdout were split by card ID hash before inference. Coverage and precision use exact Initiative/Epic pair agreement. Existing historical destinations absent from today's active catalog serve as a novelty proxy.`,
    table(['Cohort', 'Out of catalog', 'Explicit no-fit recall', 'Incorrectly accepted'], [policy.calibration, policy.holdout].map((value, index) => [
      index ? 'Holdout' : 'Calibration', value.novel, `${value.detected} / ${value.novel} (${pct(value.detected, value.novel)})`, value.falseAcceptedNovel,
    ])),
    '## Novelty proxy examples',
    table(['Card ID', 'Historical pair outside the active catalog', 'Outcome'], [...calibration, ...holdout]
      .filter(({ expected }) => expected && !known.has(pairKey(expected.initiative, expected.epic))).slice(0, 8)
      .map(({ expected, result }) => {
        const value = assess(result, policy.threshold)
        return [result.cardId, display(expected!), value.outcome === 'candidate' ? display(value.destination) : value.reason]
      })),
    '## Decision distribution',
    table(['Cohort', 'Outcome', 'Count'], [unassigned, calibration, holdout].flatMap((rows, index) =>
      reasons(rows).map(([reason, count]) => [['Unassigned', 'Calibration', 'Holdout'][index]!, reason, count]))),
    '## Historical confusion matrix (nonzero cells)',
    table(['Notion reference pair', 'Jev candidate or abstention', 'Count'], confusion),
    '## False positive audit queue',
    table(['Profile', 'Cohort', 'Card ID', 'Reference pair', 'Incorrect candidate'], evaluations.flatMap(value =>
      [value.calibration, value.holdout].flatMap(({ errors }, index) => errors.map(error => [
        value.name, index ? 'Holdout' : 'Calibration', error.cardId, display(error.truth), display(error.proposed),
      ])))),
    '## Unassigned cards',
    table(['Card ID', 'Proposed pair', 'Outcome', 'Initiative fit', 'Epic fit', 'Ambiguity', 'Parents'], unassigned.map(({ result }) => {
      const value = assess(result, policy.threshold)
      const evidence = result.state === 'examined' ? result.evidence : null
      return [result.cardId, evidence?.destination ? display(evidence.destination) : '—',
        value.outcome === 'candidate' ? value.outcome : value.reason, evidence?.initiativeFit ?? '—', evidence?.epicFit ?? '—',
        evidence?.ambiguous ?? '—', evidence?.parentCount ?? '—']
    })),
    '## Timing and OpenRouter cost',
    `Unassigned cohort completed in ${report.unassignedWallMs} ms. Full run completed in ${report.wallMs} ms. Notion foreground queue: ${JSON.stringify(notion.requests)}, ${notion.rateLimits} rate-limit responses. Jev timing measures the client-observed Decisions call, including retries. Card timing covers source context and model processing. Verified-write latency remains for the write implementation.`,
    table(['Cohort', 'Cards', 'Validated model responses', 'Jev p50 ms', 'Jev p95 ms', 'Card p50 ms', 'Card p95 ms', 'Retries in validated calls', 'Input tokens', 'Output tokens', 'Cost (credits)', 'Responses with cost'], [
      ['Unassigned', ...timings(unassigned)], ['Historical', ...timings([...calibration, ...holdout])], ['Total', ...timings(all)],
    ]),
  ].join('\n\n') + '\n'
}
