# JetStream subscribers

`events subscribe` runs one durable pull subscriber. Operators provision the
stream, durable consumer, and NKey on the engineering broker. A bridge then
connects independently with its own local receipt journal. Give each independent
delivery destination its own durable consumer. One host can supervise several
bridges.

## Mate

Run the bridge on the host of the configured home. The local configuration
binds an exact topic to that home and directs messages there independently of Main.

```json
{
  "name": "hilda",
  "flavor": "mate",
  "server": "nats://127.0.0.1:14222",
  "stream": "TINSTAR_INBOX",
  "topics": ["inbox.mate.hilda"],
  "destination": {"home": "/home/farm/fm-hilda"}
}
```

Use the existing private SSH route to forward the port or use a
certificate-verified `tls://` server endpoint. Serve one exact inbox topic per
durable consumer in the `TINSTAR_INBOX` file stream. Work queue retention with
disjoint inbox filters removes acknowledged messages and holds pending messages
while the bridge is offline. Use `discard: new` with a disk capacity limit
to preserve those pending deliveries if the broker fills. The publishing outbox
must keep an unacknowledged publish pending if the broker refuses it.

The inbox transport accepts this envelope on the matching subject:

```json
{
  "schema": "tinstar.inbox.v1",
  "event_id": "event:controlled-proof-example",
  "topic": "inbox.mate.hilda",
  "body": "[Controlled Tin Star bridge proof] Receipt test only."
}
```

The bridge invokes the local `fm-inbox.sh note --request-id <id> --json -`
with the configured `FM_HOME`. An existing note with the same request ID
returns its original receipt. If the inbox reports a save without a wake,
the bridge keeps the message pending and retries the same request. A completed
receipt confirms persistence and announcement or existing acknowledgment.
Use the home's normal receipt tools to verify handling or any later execution.

## Webhook

Provision a separate consumer for the topics the operator approves forwarding
to the owner-operated endpoint. Any external webhook route requires an
approved audience policy covering its topics and forwarded fields before
it is enabled. GrokBot is deferred to a follow-up.

```json
{
  "name": "owner-webhook",
  "flavor": "webhook",
  "server": "nats://127.0.0.1:14222",
  "stream": "TINSTAR_FACTS",
  "topics": ["tinstar.fact.example.controlled"],
  "destination": {"url": "https://owner.example.invalid/engineering/events"}
}
```

The bridge sends a POST with `Authorization: Bearer` and a stable
`Idempotency-Key`. It forwards event ID, topic, kind, event type, observation
times, and subject type and ID when present. Native evidence, provider-specific
fields, and note text stay on the bus. A 2xx response means endpoint acceptance.
For retries across an interrupted POST or local receipt write, the endpoint
must honor the idempotency key. The configured exact URL is the destination
allowlist. Use HTTPS for remote destinations. Loopback HTTP supports a
controlled local proof. Redirects are rejected.

## Broker and bridge setup

Use the subscriber `name` as the durable name. Provision an explicit-ack
pull consumer with the same topic
filters. Set an acknowledgment wait that exceeds the bridge's 15-second
destination timeout and the local receipt write. For example, with the
authenticated JetStream manager from the [broker runbook](jetstream.md):

```js
await manager.streams.add({
  name: 'TINSTAR_INBOX', subjects: ['inbox.mate.>'], storage: 'file',
  retention: 'workqueue', discard: 'new', max_bytes: 256 * 1024 * 1024,
})
await manager.consumers.add('TINSTAR_INBOX', {
  durable_name: 'hilda', filter_subject: 'inbox.mate.hilda',
  ack_policy: 'explicit', ack_wait: 45 * 1e9, max_ack_pending: 16,
})
```

Set `filter_subjects` for a webhook durable that needs multiple filters.
Provision a separate bridge NKey. In the existing engineering account, allow
publishing only to `$JS.API.CONSUMER.INFO.<stream>.<durable>`,
`$JS.API.CONSUMER.MSG.NEXT.<stream>.<durable>`, and
`$JS.ACK.<stream>.<durable>.>`. Allow subscribing only to
`_INBOX.tinstar_subscriber.<name>.>`. Stream setup and publishing to inbox
topics use separate credentials scoped to the approved destinations.

Start with the bridge seed in `EVENTS_NATS_NKEY_SEED`. Set
`EVENTS_WEBHOOK_TOKEN` from the endpoint credential for the webhook flavor.
Load secrets from Clavis or the host's service credential provider.

```sh
EVENTS_NATS_NKEY_SEED="$(clavis get tinstar/jetstream-hilda.seed)" \
  ./events subscribe --config /path/to/mate.json --db /path/to/bridge.sqlite
./events sources --db /path/to/bridge.sqlite
```

The bridge stores its receipt before acknowledging the broker message.
On redelivery with the same topic and event ID, the persisted receipt lets it
acknowledge without repeating the destination action. The `received` state
shows a persisted receipt while the bridge awaits broker acknowledgment.
Supervisor output records delivery failures, including saved notes whose wake
could not be announced. `events sources` retains the first unresolved delivery
failure until that message reaches its destination. For the full backlog, inspect
the broker consumer with `manager.consumers.info(stream, name)`. Check
`num_pending` for messages awaiting delivery, `num_ack_pending` for outstanding
acknowledgments, and `num_redelivered` for messages undergoing redelivery.

Preserve the local journal when restarting the same route. The journal refuses
a changed destination under an existing subscriber name. To migrate, coordinate
the publishing cutover so new messages wait in the publishing outbox while
you drain the old subscriber on its original route.
Confirm pending and acknowledgment counts reach zero, then register a new name
with its own durable and switch publishing to the new route. If a pre-fingerprint
journal already contains a subscriber registration, drain it with the original
bridge and configuration before upgrading.
