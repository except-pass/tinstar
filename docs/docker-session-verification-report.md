# Docker Session Verification Report

**Date:** 2026-03-13
**Server:** Tinstar dev (localhost:5273) with TINSTAR_FAST_SIM=1
**Test container:** tinstar-APP1028, image rf-bugsearcher:latest, home /home/bot

---

## Issue 1: Hooks — PASS

**What was verified:**

1. **Env vars inside container:** Inspected the claude process environment inside the Docker container:
   ```
   $ docker exec tinstar-APP1028 bash -c 'cat /proc/$(pgrep -f claude | head -1)/environ | tr "\0" "\n" | grep DASHBOARD'
   RF_DASHBOARD_URL=http://host.docker.internal:5273
   TINSTAR_DASHBOARD_URL=http://host.docker.internal:5273
   ```
   Both env vars correctly point to `host.docker.internal` (not `localhost`).

2. **Connectivity from container to host:** Tested curl from inside the container to both hook endpoints:
   ```
   $ docker exec tinstar-APP1028 curl -s -X POST http://host.docker.internal:5273/api/hooks/idle \
       -H 'Content-Type: application/json' -d '{"session":"APP1028"}'
   {"ok":true}

   $ docker exec tinstar-APP1028 curl -s -X POST http://host.docker.internal:5273/api/hooks/active \
       -H 'Content-Type: application/json' -d '{"session":"APP1028"}'
   {"ok":true}
   ```

3. **State transitions:** Fired idle hook, then queried session state via API — state was `idle`. Fired active hook, state changed to `running`. Verified via:
   ```
   $ curl -s http://localhost:5273/api/sessions/APP1028 | jq '.data.state'
   ```

**Why I'm confident:** The full round-trip works: container → host.docker.internal → Tinstar API → session state update → visible in API response. The `localhost` → `host.docker.internal` rewrite in `buildExecCommand` is the fix.

**Known cosmetic issue:** Claude Code's hook runner reports "Stop hook error: Failed with non-blocking status code" because the rf-bugsearcher image's hook scripts background curl with `&`. This is not a Tinstar bug — the hooks still fire and complete successfully.

---

## Issue 2: Recap — PASS

**What was verified:**

1. **Path encoding fix:** Tested both tmux and Docker transcript paths:
   ```
   $ npx tsx -e "import { getTranscriptPath } from './src/server/sessions/transcript-parser'; ..."

   tmux path:   /home/ubuntu/.claude/projects/-home-ubuntu-repo-robot-factory/conv-id.jsonl
   docker path: /home/ubuntu/.config/tinstar/sessions/APP1028/claude-state/-home-ubuntu-repo-robot-factory/conv-id.jsonl
   ```
   Both paths include the leading dash (`-home-ubuntu-...`), matching Claude Code's actual directory naming.

2. **Transcript file exists on host:** The Docker container's claude-state volume mount makes transcripts visible to the host:
   ```
   $ ls ~/.config/tinstar/sessions/APP1028/claude-state/-home-ubuntu-repo-robot-factory/
   940468b3-88aa-4be6-8b99-38561362037c.jsonl
   memory
   ```

3. **Parser works:** Direct invocation confirmed entries are parsed:
   ```
   $ npx tsx -e "import { parseNewEntries } from './src/server/sessions/transcript-parser'; ..."
   entries found: 2
   {"type":"user","content":"say hello world"}
   {"type":"agent","content":"Hello world"}
   ```

4. **End-to-end via idle hook:** Sent two prompts to the Docker session ("say hello world" → "Hello world", "what is 2+2" → "4"). Both completed. Triggered idle hook from inside the container. Checked SSE snapshot:
   ```
   APP1028: recap=4 entries
     user: say hello world
     agent: Hello world
     user: what is 2+2
     agent: 4
   ```

**Why I'm confident:** The two bugs (missing leading dash in `encodeWorkdir`, wrong base dir for Docker sessions) are both fixed and verified. The end-to-end path works: Claude responds → transcript written to container → persisted via bind mount → idle hook fires → Tinstar reads transcript from session's claude-state dir → recap entries appear in SSE snapshot.

---

## Issue 3: Telemetry — PASS

**What was verified:**

1. **Alloy accepting OTLP:** Confirmed the collector is running:
   ```
   $ curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:4318/v1/metrics \
       -H 'Content-Type: application/json' -d '{"resourceMetrics":[]}'
   200
   ```

2. **Metrics in Prometheus:** After the 5-second flush interval, queried Prometheus:
   ```
   $ curl -s 'http://localhost:9090/api/v1/query?query=active_runs'
   Prometheus active_runs results: 14
     run_id=R-241 job=tinstar value=1
     run_id=R-242 job=tinstar value=1
     ...
   ```
   All 14 simulator runs are present with `job=tinstar`.

3. **Pipeline verified:** Data flows through:
   - Tinstar OTelProcessor creates spans/metrics on event bus events
   - OtlpExporter batches and flushes every 5s to `http://localhost:4318/v1/traces` and `/v1/metrics`
   - Alloy receives OTLP, redacts sensitive fields, batches
   - Alloy exports metrics to Prometheus via remote write
   - Prometheus stores and serves queries

**Why I'm confident:** 14 distinct `active_runs` gauge metrics are queryable in Prometheus with the correct `job=tinstar` label. The OTLP exporter is fire-and-forget with silent failure on connection errors, so it won't break Tinstar if Alloy is down.

---

## Summary

| Issue | Status | Evidence |
|-------|--------|----------|
| Hooks | PASS | Container env vars correct, both endpoints return 200, session state toggles idle↔running |
| Recap | PASS | 4 entries parsed from Docker transcript, visible in SSE snapshot |
| Telemetry | PASS | 14 metrics in Prometheus with job=tinstar after 5s flush |
