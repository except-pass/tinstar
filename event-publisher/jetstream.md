# JetStream journal relay

The relay publishes selected journal facts to the standalone Tin Star
engineering broker. It runs independently of `events serve`. Hulk keeps the
signed Jira ingress and the authoritative SQLite journal. Serena hosts the floor
and the broker. Nothing here needs access to a customer broker or credentials.

## Install the broker on Serena

Use the Ubuntu `nats-server` package. Before the package starts its service,
place the rendered [NATS config](deploy/nats-server.conf.example) at
`/etc/tinstar-jetstream/nats.conf` and the
[systemd drop-in](deploy/nats-server.service.conf) at
`/etc/systemd/system/nats-server.service.d/tinstar.conf`. The packaged unit
uses the `nats` account and the drop-in creates a persistent, private
`/var/lib/tinstar-jetstream` state directory. Validate the rendered configuration
with `nats-server -t -c /etc/tinstar-jetstream/nats.conf` and confirm the final
listener is limited to Serena loopback. There is no monitoring HTTP listener.

Provision two NATS user NKeys. Store the relay seed as
`tinstar/jetstream-hulk.seed` in Hulk's Clavis vault and the admin seed as
`tinstar/jetstream-admin.seed` in the operator's vault. Render only the public
keys into the config. The relay can publish the Jira fact subjects and receive
replies under its own prefix. Only the admin identity can access the JetStream
management API. SSH forwards the client socket over the existing private
Serena route.

Create the stream once using the admin identity. From `event-publisher/`,
with the local SSH forward active and the admin credential available through Clavis:

```sh
EVENTS_NATS_NKEY_SEED="$(clavis get tinstar/jetstream-admin.seed)" node --input-type=module <<'JS'
import { jetstreamManager } from '@nats-io/jetstream'
import { connect, nkeyAuthenticator } from '@nats-io/transport-node'

const nc = await connect({ servers: 'nats://127.0.0.1:14222', inboxPrefix: '_INBOX.tinstar_admin',
  authenticator: nkeyAuthenticator(Buffer.from(process.env.EVENTS_NATS_NKEY_SEED.trim())) })
try {
  const manager = await jetstreamManager(nc)
  await manager.streams.add({
    name: 'TINSTAR_FACTS', subjects: ['tinstar.fact.>'], storage: 'file',
    max_age: 30 * 24 * 60 * 60 * 1e9, max_bytes: 256 * 1024 * 1024,
    duplicate_window: 10 * 60 * 1e9,
  })
} finally {
  await nc.close()
}
JS
```

## Start the relay on Hulk

Run one relay process per configured name. Use a supervised SSH forward and
relay for unattended operation. The publisher and forward can run independently
of the relay.

```sh
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -L 127.0.0.1:14222:127.0.0.1:4222 serena-1
```

In a second terminal, from the installed Event Publisher:

```sh
EVENTS_NATS_NKEY_SEED="$(clavis get tinstar/jetstream-hulk.seed)" \
  ./events relay --config deploy/hulk-jira-relay.json \
  --db /home/farm/srv/event-publisher/data/journal.sqlite
```

The [Hulk config](deploy/hulk-jira-relay.json) selects only Jira status change
facts. Adding an event type to the relay selection requires an approved
publisher change that covers the event type and its audience. Fixture events
always stay local. The relay name also sets the reply prefix
`_INBOX.tinstar_relay.<name>` and must agree with the broker permission.

`startAfter` is the exclusive sequence for a new relay, defaulting to zero.
Record the current journal tip before rollout and set it explicitly if the
approved cutover starts there. An existing named relay continues from its
saved cursor. It skips events excluded by the selection. When changing event
coverage, select an intentional historical cursor with a new relay name and
provision its reply permission if earlier matching events should be sent.

### Verify the permanent cutover

After the PR merges with green checks, use `events replay --source jira --json`
against Hulk's live journal to record the sequence and event ID of an existing
signed Jira status fact. Check replay to Serena from an isolated journal backup
before starting the permanent relay. Keep Hulk's signed Jira ingress and
publisher running throughout the cutover. Install and start the permanent Hulk
relay as a supervised service with the live journal and supervised SSH forward.

After cutover, arrange one new authentic Jira status change that triggers a
signed delivery. Replay the live journal after the recorded sequence with
`events replay --source jira --after <sequence> --json` and confirm signed
delivery evidence. Check `events sources` for relay progress and use Serena's
JetStream management API to replay the stored fact and match its event ID to
the live journal. Keep stage 1 open until the before-and-after replay and the
new delivery through Hulk ingress, the live journal, the relay and Serena
are recorded. Perform this rollout after merge.

## Facts and recovery

Fact subjects have the form
`tinstar.fact.<provider>.<subject-type>.<base64url(UTF-8 subject-id)>`.
The payload carries the existing versioned event envelope and the additional
`kind: "fact"` and `topic` fields. A Jira status transition is historical
evidence. A dependency check needs a separate fresh current-state
observation. The journal sequence is local to the originating journal.

The committed journal is the durable outbox. The relay advances its SQLite
cursor past a selected event only after a publish acknowledgment from the
expected stream. A crash or lost acknowledgment reuses the original
`event_id` as the NATS message ID. JetStream deduplicates inside its
configured window. Consumers must deduplicate logical effects by the stable
event ID even after that window. Broker acknowledgment confirms stream
persistence only.

`events sources --db <path>` reports selected relay health, the processed
sequence, the last broker acknowledgment and the failing sequence during
retries. Compare it with `events replay --db <path>` to locate pending facts.
Check the SSH forward, broker credentials and stream permissions for persistent
failures. Repair the failed dependency and restart the relay to resume from
the saved cursor. The source publisher and journal CLI remain available
through a broker outage.

Access to full Jira envelopes, including issue metadata, status transitions
and any actor account ID, is restricted to the authenticated Tin Star
engineering account's approved audience. That audience comprises Tin Star
and the owner's First Mate bridges, all owner-operated with the same TSW
visibility as Hulk journal readers. This restriction applies to management
API retrieval and replay as well as live delivery. Keep broker history for
replay and recovery within the stream's 30-day and 256 MiB limits. Use the
journal for replay beyond that window.

When replacing the broker or stream, stop the named relay, provision the
replacement stream and update the relay config with `startAfter` set to `0`.
As the journal owner on Hulk, remove only that relay's checkpoint from the
live journal, then restart the relay to replay eligible facts from zero.
For the shipped `hulk-jira` relay, run:

```sh
sqlite3 -cmd '.timeout 5000' /home/farm/srv/event-publisher/data/journal.sqlite \
  "DELETE FROM jetstream_relays WHERE name = 'hulk-jira';"
```

Replay uses the original event IDs. JetStream suppresses duplicate IDs within
its configured window, and consumers use those IDs to deduplicate logical
effects beyond that window.
