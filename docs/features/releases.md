# Releases

Releases is a PR-first observation page (`?view=releases`). Each table row is a
GitHub PR, with its linked Notion cards in the same row. Initiative → Epic is
inherited from the cards' existing Work properties; Repository is an alternative
preset. A PR can appear in several groups while keeping one canonical
`repository#number` identity, selection and count. Search uses the shared compact
Smart Search palette and exact/full-text/fuzzy index, including available linked
card prose. Card links open the real card in Tin Star (`?card=<page-id>`).

## Associations

The reader imports explicit GitHub PR URLs in active cards' `Link`, `GitHub`,
`GitHub PRs` and `Pull requests` properties. It does not guess links from titles,
worker assignments or prose. Done/archived historical cards are not mass imported.
A missing PR declaration on a Waiting for Prod Release card appears under
Exceptions, outside the PR table.

Additional many-to-many associations and local exclusions are audited in
`<getConfigRoot()>/releases/associations.json`. The append-only event history
records a retry ID, PR URL, card ID, link/unlink, authenticated owner, UTC time
and reason. Unlink locally excludes that edge while retaining its Notion source
and audit history; it does not edit Notion. A later link can restore it. An
unreadable/corrupt audit is reported visibly and never overwritten as an empty
store. Local audit persistence uses atomic replacement under the existing single
server/config-root boundary. There is no shared database or new service.

Editing uses the same `ask.ownerLogins` and trusted local Tailscale Serve identity
boundary as Ask: the backend must be loopback-only behind the tailnet proxy.
The UI handshake and allowed browser origin are required for writes. Only cards
in the authorized Notion source can be linked. Read-only operation remains
available without configured owner logins. A directly exposed backend must never
trust a client-supplied Tailscale identity header (see [Ask](ask.md)).

## Evidence and current boundaries

GitHub supplies PR title, merged state/time and effective merge commit. Reads
use the existing gh-axi scalar transport, at most four PR reads per refresh and
no repository crawl. Successful merged identities cache for ten minutes so a
bounded reader can cover the queue; open/failed reads retry after one minute.
Failures retain visibly stale facts. The navigation badge is unknown (`?`) while
any association's GitHub state is unresolved; it never presents a partial
observation as a complete zero. Its eventual count is unique merged PRs awaiting
production evidence, not cards or repeated group references.

This first slice does not prove deployed-component identity. In Queue includes
merged PRs and unresolved observations, with actual state shown as deployment
unknown or Exception. Shipped and Verify in Prod stay empty until reconciliation
has verified evidence. Neither Notion Done nor a version tag implies shipment.
The on-demand drawer shows merge provenance, link history and direct links. The
sync disclosure explicitly reports unknown deployed version and absent successful
reconciliation. No Notion writer, automatic transition, production-verification
routing, deployment action or mass backfill exists in this slice.

Multi-select PR action toolbar + shared custom-action framework: not present in
main; deferred to its own card. The table preserves canonical row selection for
future reuse, existing Ask/inspect and direct GitHub/Tin Star links. It does not
introduce an action execution engine.

The next read-only slice consumes actual component receipts (including cmsandbox
coordinator results where available), checks merge ancestry per repository and
target, and reports dry-run eligibility. Enabling automatic Notion Done and
opt-in verification routing remains a separate rollout gate with simultaneous
board-guide and PM-bot sweep updates.
