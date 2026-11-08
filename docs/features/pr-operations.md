# PR Operations

The **PRs** destination shows one compact row per observed open GitHub PR. Repository is the first data column and sorts in both directions. Search matches repository, title, number, author and observed work/contributor context. Select rows without losing hidden selections; the selection summary appears only while a selection exists. This slice provides inspection only.

Click row body or its keyboard-accessible Inspect button to expand the actual description, additions/deletions/file count, check/review observations and explicit work/contributor evidence inline. GitHub links remain direct. Counts/checks/reviews are **unknown until inspected**; details are cached for two minutes per canonical PR and captured head. A changed head cannot reuse the old detail. Review approvals are observations, not a claim that all branch policy requirements are satisfied. File categorization, typed PR Ask and installed actions are follow-on slices.

## Sources and scope

GitHub reads use `gh-axi api GET` with its existing local authentication. `gh-axi` must be in the backend service PATH. Missing CLI/auth/access failures appear as repository errors, with last-known rows explicitly stale. No GitHub write endpoint exists in PR Operations.

Inventory and detail require a Tailscale-User-Login listed in `ask.ownerLogins`, forwarded through the loopback-only backend trust boundary used by Ask. Missing or unauthorized identity returns 403 with a visible page error.

Repository scope defaults to the union of PRs with active card links in the shared Releases association projection and configured fleet execution PR registrations. The authenticated GitHub account and its organization memberships define owned repositories: all open PRs in those repositories are included, even when unlinked. Other repositories include only open PRs authored by that account or explicitly associated with a card or worker. A removed card link no longer qualifies a foreign PR unless it is still authored by the account or explicitly associated elsewhere. This does not claim every accessible GitHub repository is scanned. To choose scope, add ordinary configuration under the server's `getConfigRoot()/config.json`:

```json
{
  "prOperations": {
    "repositories": ["owner/repository", "another/repository"]
  }
}
```

An explicit repository list replaces discovered scope. This does not widen the foreign PR relevance rule. The page exposes each repository's coverage and errors. A request reads at most 32 repositories, four concurrently, and 1,000 open PRs per owned repository (100 per page). Foreign repositories use one author-filtered search (up to 100 results), then fetch summaries only for those results and explicit associations; omitted repositories/pages are visibly reported. Inventory and account/organization identity are cached for one minute and shared between clients. Inventory cache keys include the account, ownership and explicit foreign associations so scope changes cannot reuse broader rows. Search truncation or failure remains visibly partial; explicit associations are still attempted. Details read only when inspected, using the existing bounded QueuePullReader for check evidence and at most the first 100 review records (labelled partial when the page is full). Failed refreshes retain old evidence with a stale label, never fresh absence or green checks. A foreign PR successfully observed as closed is removed even when search or another summary read fails; only rows whose current state remains unknown can survive as stale evidence.

Canonical PR identity and many-to-many card edges come directly from `src/shared/releases.ts` and the **same** `AssociationStore` instance used by Releases. PR Operations has no second link store and does not write Notion. The shared automatic association scan covers operational cards; “unlinked” means no link in that scope. Missing/partial/stale association sources remain unknown. Snapshot PR registration identifies reported workers; it is not a durable historical contributor index. Manager home and observed/configured machine remain distinct.

## Navigation and receipts

See [README navigation](../../README.md) for activity destinations, worker switching and message receipts. The Ask inbox stays in Your Desk with its existing permissions and conversation lifecycle. PRs opens the persistent shared Desk directly; typed PR Ask will reuse that inbox in its own slice.

The [README URL table](../../README.md#worker-links) lists supported deep links. A navigation switch closes auxiliary panels so they do not become empty orphan drawers. At narrow widths the PR table scrolls horizontally; metadata and GitHub links remain available.

## Change footprint and contributor evidence

Inspect also loads `/api/pulls/files` through the same owner-only, GET-only boundary. Files come from GitHub, never a local worktree or LLM. The reader paginates 100 files per page up to GitHub's [3,000-file provider limit](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files). It compares observed file count with GitHub's changed_files and checks head and base commit before and after pagination. A push or base change during the read requires refresh; mixed diffs are not published. Successful observations cache for two minutes per canonical PR/head; partial reads retry after 15 seconds. A new head cannot reuse old footprint evidence. Failed refreshes may retain the same head/base observation explicitly stale.

Ordered classification is Generated & Dependencies → Tests/fixtures → Docs → Config → Code → Other. Common generated/vendor/output paths and lockfiles take precedence over extensions. Thus src/generated/client.ts is generated and Tests/config.test.ts is a test. Each category shows observed additions + deletions, percent of the displayed denominator and file count. A category opens the actual files sorted by changed lines; links target their GitHub PR diff. Renames retain previous filename. Binary/metadata-only entries remain listed with zero line changes. The optional view excluding generated/dependencies prevents a lockfile from obscuring the rest; Handwritten Code counts only the Code category. Partial results always label percentages as observed coverage.

The shared Releases join now also recognizes a **confirmed, current, explicit Notion First Mate tasks claim** for an exact worker execution with a registered PR. Manual association/unlink audit is applied last and remains authoritative. Unverified, conflicting or historical worker-card claims never become confirmed active PR/card edges. Fleet source failures make association completeness unknown. PR Operations and Releases consume this same join; neither has a second mapping.

Contributor evidence joins canonical PR identity to exact First Mate home/task/attempt registration. Multiple executions are preserved. It shows current home accountability and configured parent home separately from observed/configured/unknown machine placement, registration source, timestamp and registered head compared with GitHub. A recorded finished/absent worker is Historical; a stale source is Last known. Retained backlog.pr_url registrations can identify retired logical tasks even without an execution. Their missing generation, historical manager, head and placement stay Unknown. Suggested/unverified and historical Notion claims remain labeled evidence. A PR with no registration remains unknown, regardless of title, author or repository.

Current and retained registrations are not a complete durable contributor index. Relationship history retains the existing bounded in-memory scope and resets on server restart. No Tin Star-owned attribution database or First Mate repository changes are introduced by this slice.
