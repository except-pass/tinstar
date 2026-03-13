import type { RunData } from '../types'

export const mockRun: RunData = {
  id: 'R-241',
  status: 'running',
  sessionId: 'CLD-4092',
  initiative: 'AI Dev Platform',
  epic: 'Codebase Hygiene',
  task: 'Reduce Scheduler Slop',
  repo: 'acme/platform-core',
  worktree: 'feat/scheduler-priority',
  touchedFiles: [
    { id: 'f1', name: 'scheduler.go', path: 'pkg/api/v1', additions: 124, deletions: 12, kind: 'code' },
    { id: 'f2', name: 'queue_test.ts', path: 'internal/test', additions: 45, deletions: 0, kind: 'test' },
    { id: 'f3', name: 'config.yaml', path: 'deploy/k8s', additions: 2, deletions: 2, kind: 'config' },
    { id: 'f4', name: 'run.sh', path: 'scripts/', additions: 8, deletions: 1, kind: 'script' },
    { id: 'f5', name: 'priority.go', path: 'pkg/api/v1', additions: 67, deletions: 0, kind: 'code' },
    { id: 'f6', name: 'README.md', path: 'docs/', additions: 14, deletions: 3, kind: 'doc' },
    { id: 'f7', name: 'Makefile', path: './', additions: 4, deletions: 1, kind: 'script' },
    { id: 'f8', name: 'handler.go', path: 'pkg/api/v1', additions: 31, deletions: 8, kind: 'code' },
  ],
  recapEntries: [
    {
      id: 'r1',
      type: 'agent',
      content: 'Modified scheduler.go to implement priority-based queuing. Running integration tests now...',
      timestamp: '14:32:08',
      diff: {
        filename: 'scheduler.go',
        header: '@@ -14,4 +14,5 @@',
        lines: [
          { type: 'context', content: 'func (s *Scheduler) Next() Job {' },
          { type: 'deletion', content: '    return s.Queue.Pop()' },
          { type: 'addition', content: '    priorityJob := s.PriorityQueue.Pop()' },
          { type: 'addition', content: '    return priorityJob' },
          { type: 'context', content: '}' },
        ],
      },
    },
    {
      id: 'r2',
      type: 'status',
      content: 'Running Benchmark Suite: Core_Engine_V4',
      timestamp: '14:32:15',
    },
    {
      id: 'r3',
      type: 'user',
      content: 'Looks solid. Deploy the updated scheduler to the staging environment after the tests pass.',
      timestamp: '14:33:41',
    },
    {
      id: 'r4',
      type: 'agent',
      content: 'Acknowledged. Benchmark suite completed — all 47 tests passing. Preparing staging deployment via deploy/k8s/config.yaml. Updated replicas and resource limits for the priority queue worker.',
      timestamp: '14:35:02',
      diff: {
        filename: 'config.yaml',
        header: '@@ -8,3 +8,3 @@',
        lines: [
          { type: 'context', content: 'spec:' },
          { type: 'deletion', content: '  replicas: 2' },
          { type: 'addition', content: '  replicas: 3' },
          { type: 'context', content: '  template:' },
        ],
      },
    },
  ],
  rawLogs: `[14:32:01] claude-agent: Starting run R-241
[14:32:01] claude-agent: Analyzing task: Reduce Scheduler Slop
[14:32:03] claude-agent: Reading pkg/api/v1/scheduler.go
[14:32:04] claude-agent: Identified inefficiency in Queue.Pop() — no priority ordering
[14:32:05] claude-agent: Writing pkg/api/v1/priority.go (new file)
[14:32:06] claude-agent: Modifying pkg/api/v1/scheduler.go — replacing FIFO with priority queue
[14:32:08] claude-agent: Running: go test ./pkg/api/... -v
[14:32:12] test: === RUN   TestSchedulerNext
[14:32:12] test: --- PASS: TestSchedulerNext (0.02s)
[14:32:12] test: === RUN   TestPriorityOrdering
[14:32:13] test: --- PASS: TestPriorityOrdering (0.01s)
[14:32:13] test: === RUN   TestQueueDrain
[14:32:13] test: --- PASS: TestQueueDrain (0.03s)
[14:32:14] test: PASS — 47/47 tests passed
[14:32:15] claude-agent: Running benchmark suite: Core_Engine_V4
[14:33:20] bench: BenchmarkSchedulerNext    500000    2341 ns/op    128 B/op    3 allocs/op
[14:33:22] bench: BenchmarkPriorityPop      800000    1502 ns/op     96 B/op    2 allocs/op
[14:33:24] bench: Benchmark complete — 36% improvement in scheduling throughput
[14:34:01] claude-agent: User approved staging deploy
[14:35:02] claude-agent: Updated deploy/k8s/config.yaml — replicas: 2 → 3
[14:35:03] claude-agent: Running: kubectl apply -f deploy/k8s/config.yaml --dry-run=client
[14:35:05] kubectl: deployment.apps/scheduler configured (dry run)
[14:35:06] claude-agent: Dry run successful. Awaiting final deploy confirmation.`,
  port: null,
  backend: null,
}
