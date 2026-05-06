# Hand Archetypes

A starting catalog for picking your roster. The live source of truth for what's installed is `GET /api/hands` on the Tinstar control plane — consult that if an archetype here is missing.

## Common archetypes for /all-hands

| Archetype | Lane | Typical standing watch | Typical review focus |
|-----------|------|------------------------|----------------------|
| **skeptic** | Edge cases, hidden assumptions | Major architectural choices in commit subjects | Have we considered failure modes, retries, partial states? |
| **security-scanner** | Secrets, auth, input validation | Changes under `auth/`, new env vars, new external calls | Token handling, AuthN/AuthZ paths, injection vectors |
| **tester** | Coverage, testability | New public APIs, untested files in commits | New code is covered, tests assert behavior not implementation |
| **rubberduck** | Conceptual clarity | New abstractions, complex commits | Are names right? Can a stranger understand the change? |
| **docs** | Public contract clarity | Public API changes, README/CHANGELOG-relevant commits | Public surface is documented, examples still work |
| **perf** | Hot paths, allocation, big-O | Loops, queries, N+1 risk, new dependencies | Latency budget respected, no obvious regressions |
| **bugsearcher** | Adjacent bugs in the same area | File touches near known fragile code | Did this change reveal or introduce neighboring bugs? |
| **fixer** | Build/typecheck health | Any commit | Tests pass, types check, no broken imports |
| **cleanup** | Consistency, dedup | Patterns that diverge from the rest of the codebase | Style/naming aligned with surrounding code |
| **pr-responder** | Reviewability | Commit hygiene, large diffs | Diff is reviewable, commit messages explain WHY |
| **surveyor** | Architectural fit | Cross-cutting changes | New code lives in the right place, follows established patterns |

## Picking a roster

A solid default for a security-sensitive feature: **security-scanner + tester + skeptic + rubberduck** (4 hands). Add `perf` for anything in a hot path. Add `docs` for public-API changes. Add `surveyor` for cross-cutting refactors.

For most features, 4 hands is enough. 8 is the absolute ceiling — past that, briefing collapses under its own weight.

## Archetype selection heuristic

Ask: "If this ships broken, what kind of broken?"

- Wrong behavior under edge case → **skeptic**
- Security incident → **security-scanner**
- Silent regression → **tester**
- Confusing API for users → **docs** + **rubberduck**
- Slow queries / latency regression → **perf**
- Doesn't fit the codebase → **surveyor**

Pick one hand per realistic failure mode. Skip hands whose failure modes don't apply.
