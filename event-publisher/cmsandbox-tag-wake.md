# Main cmsandbox tag wake check

Install `event-publisher/cmsandbox-tag-wake.check.sh` as an executable check on
First Mate Main. It takes no arguments and uses Bash, `ssh`, `jq`, `flock`,
and GNU `timeout`. Main needs batch SSH access to the Hulk service account
and read access through the installed `events replay` CLI.

| Environment input | Default |
| --- | --- |
| `HULK_SSH` | `farm@hulk.taile890bc.ts.net` |
| `TAG_WAKE_REMOTE_EVENTS` | `/home/farm/srv/event-publisher/app/event-publisher/events` |
| `TAG_WAKE_REMOTE_DB` | `/home/farm/srv/event-publisher/data/journal.sqlite` |
| `TAG_WAKE_CURSOR` | `cmsandbox-tag-wake.cursor` alongside the installed check |

The cursor is a single decimal sequence in the Hulk journal. Give the check a
writable cursor directory. With no cursor file, the check reads after sequence
zero, which includes the seeded newest tag for a newly enabled source. To
start at a later point when installing against an existing journal, put the
last acknowledged sequence in the cursor file before enabling the check.

Stdout has one line per new `tag.pushed` event, in journal order. These lines
report release activity before PROD delivery is verified.

```text
tag pushed fortresspower/cmsandbox <tag> <commit-sha> <observed-at-UTC> <seeded|created|moved|restored> #<sequence>
```

The check is silent on an empty replay and advances past tag deletions, repeat
ref changes and enrichment events. It writes the cursor atomically after
emitting the batch. If a process is interrupted between emission and the
cursor update, a retry can repeat those lines with the same sequence numbers.
A sibling lock file prevents overlapping checks from emitting the same batch.

Exit `0` means the replay completed or another invocation holds the lock.
Exit `1` reports a read, replay, output, or cursor error on stderr. Failed
reads keep the cursor available for retry.
