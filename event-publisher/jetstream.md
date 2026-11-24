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
facts. Review each event type and its audience before adding one, since
journal envelopes can contain restricted source information. Fixture events
always stay local. The relay name also sets the reply prefix
`_INBOX.tinstar_relay.<name>` and must agree with the broker permission.

`startAfter` is the exclusive sequence for a new relay, defaulting to zero.
Record the current journal tip before rollout and set it explicitly if the
approved cutover starts there. An existing named relay continues from its
saved cursor. It skips events excluded by the selection. When changing event
coverage, select an intentional historical cursor with a new relay name and
provision its reply permission if earlier matching events should be sent.

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
through a broker outage. The broker retains a bounded recent window, and the
journal remains the source for historical replay.
