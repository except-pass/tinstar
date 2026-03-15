# Docker Session Fixes: Hooks, Recap, Telemetry

## Issue 1: Hooks

**Problem:** Claude Code hooks inside Docker containers call back to the Tinstar dashboard at `http://localhost:5273`, but `localhost` inside a container refers to the container itself, not the host machine. The curl silently fails or hits nothing.

**Fix:** In `buildExecCommand` (`src/server/sessions/backends/docker.ts`), rewrite `localhost` to `host.docker.internal` in the dashboard URL before passing it as `TINSTAR_DASHBOARD_URL` and `RF_DASHBOARD_URL` env vars. The containers already have `--add-host=host.docker.internal:host-gateway` set.

**Note:** The rf-bugsearcher image's hook scripts background curl with `&` and redirect to `/dev/null`, which causes Claude Code's hook runner to report "Stop hook error: Failed with non-blocking status code". This is cosmetic — the hooks still fire and data reaches Tinstar. Fixing this requires changing the image's scripts, not Tinstar.

**Verification:**
1. Create a Docker session via API
2. Confirm env vars inside the claude process: `docker exec <container> bash -c 'cat /proc/$(pgrep -f claude | head -1)/environ | tr "\0" "\n" | grep DASHBOARD'` — should show `http://host.docker.internal:5273`
3. Confirm connectivity: `docker exec <container> curl -s -X POST http://host.docker.internal:5273/api/hooks/idle -H 'Content-Type: application/json' -d '{"session":"<name>"}'` — should return `{"ok":true}`
4. Send a prompt to the session, wait for it to go idle, then check session state via `GET /api/sessions/<name>` — state should toggle between `running` and `idle`

**Definition of done:** Hook calls from inside Docker containers reach the Tinstar server and update session state (running/idle transitions visible on the dashboard).

---

## Issue 2: Recap

**Problem:** Two bugs prevent recap from working for Docker sessions:

1. `encodeWorkdir()` in `src/server/sessions/transcript-parser.ts` strips the leading dash from the encoded path. It produces `home-ubuntu-repo-robot-factory` but Claude Code stores projects at `-home-ubuntu-repo-robot-factory` (with leading dash). The transcript file is never found.

2. `parseNewEntries()` always looks for transcripts in `~/.claude/projects/` on the host. For Docker sessions, the transcript is written inside the container and persisted via the claude-state bind mount at `~/.config/tinstar/sessions/<name>/claude-state/`. The host `~/.claude/projects/` has no transcript for Docker conversations.

**Fix:**
1. Remove the `.replace(/^-/, '')` from `encodeWorkdir()` so the encoded path keeps the leading dash
2. Add an optional `stateDir` parameter to `getTranscriptPath()` and `parseNewEntries()`. In the `/api/hooks/idle` handler in `routes.ts`, detect Docker sessions (`session.backend === 'docker'`) and pass `join(sessDir, name, 'claude-state')` as the stateDir

**Verification:**
1. Unit test the path: `getTranscriptPath('/home/ubuntu/repo/robot-factory', 'conv-id')` should produce `~/.claude/projects/-home-ubuntu-repo-robot-factory/conv-id.jsonl`
2. Docker path: `getTranscriptPath('/home/ubuntu/repo/robot-factory', 'conv-id', '~/.config/tinstar/sessions/APP1028/claude-state')` should produce `~/.config/tinstar/sessions/APP1028/claude-state/-home-ubuntu-repo-robot-factory/conv-id.jsonl`
3. Start a Docker session, send a prompt, wait for idle hook to fire.  Sending prompt requires an additional sendkeys enter key to be sent.
4. Check `GET /api/sessions/<name>/recap` — should contain the user prompt and assistant response

**Definition of done:** After a Docker session goes idle, its recap entries appear in the recap API and are visible in the dashboard's recap panel.

---

## Issue 3: Telemetry

**Problem:** Tinstar collects OTel spans and metrics in memory (`OTelStore`) via `OTelProcessor`, but never exports them. The data is only accessible via Tinstar's own `/api/otel/spans` and `/api/otel/metrics` endpoints. Grafana/Prometheus have no way to see it. The existing OTel infrastructure (Alloy → Prometheus + Loki) expects OTLP data pushed to Alloy at `localhost:4318`.

**Fix:** Create `src/server/stores/otlp-exporter.ts` — an `OtlpExporter` class that:
- Buffers spans and metrics in memory
- Flushes every 5 seconds via `setInterval`
- POSTs to `http://localhost:4318/v1/traces` (spans) and `http://localhost:4318/v1/metrics` (metrics) using OTLP JSON format
- Silently drops on connection failure (Alloy may not always be running)
- Uses `OTEL_EXPORTER_OTLP_ENDPOINT` env var to override the default endpoint

Wire it into `OTelProcessor`: after every `store.addSpan()` / `store.recordMetric()` call, also call `exporter.pushSpan()` / `exporter.pushMetric()`.

**Verification:**
1. Start the dev server (with or without `TINSTAR_FAST_SIM=1`)
2. Confirm Alloy is accepting: `curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:4318/v1/metrics -H 'Content-Type: application/json' -d '{"resourceMetrics":[]}'` — should return 200
3. Create a session or wait for simulator activity
4. Query Prometheus: `curl -s 'http://localhost:9090/api/v1/query?query=active_runs'` — should return results with `job: "tinstar"`
5. Check Grafana dashboard at `http://localhost:3333` — tinstar metrics should appear

**Definition of done:** Tinstar metrics (`active_runs`, `files_touched`, `commands_run`) appear in Prometheus with `job: "tinstar"` and are queryable in Grafana.

---

## Files Changed

| File | Change |
|------|--------|
| `src/server/sessions/backends/docker.ts` | Rewrite `localhost` → `host.docker.internal` in dashboard URL for exec env vars |
| `src/server/sessions/transcript-parser.ts` | Fix `encodeWorkdir` leading dash; add `stateDir` param for Docker transcript path |
| `src/server/api/routes.ts` | Pass `stateDir` for Docker sessions in idle hook handler |
| `src/server/stores/otlp-exporter.ts` | New file — OTLP HTTP exporter that flushes to Alloy |
| `src/server/processors/otel-processor.ts` | Wire exporter into all span/metric writes |

## Current Status

- [x] Hooks: fix applied, verified via curl and env var inspection
- [x] Recap: path fix applied, verified via `npx tsx` path output test
- [x] Telemetry: exporter created, verified via Prometheus query (`active_runs` data present)
- [ ] End-to-end: need a Docker session to complete a prompt cycle and confirm recap entries appear
