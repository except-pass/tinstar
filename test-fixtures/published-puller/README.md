# Published Ask puller

`6.0.0/ask-puller.py` is the unmodified script from the released Tin Star 6.0.0 package (`package/scripts/ask-puller.py`).
Its version and SHA-256 remain pinned in `supported.json`; `latest.json`
identifies the newest packaged release. The shared contract checks
the digest before execution so editing the fixture cannot silently turn this
into a test of today's client. The fixture was compared byte-for-byte with
`package/scripts/ask-puller.py` in the released `tinstar-6.0.0.tgz`, whose
`package/package.json` declares version `6.0.0`. Tin Star is not on npm; CI
uses this vendored release without downloading a client.

The Ask HTTP test in `src/server/ask/__tests__/ask.test.ts` and the **Published
Mac puller contract** CI job share `contract.ts` and `fm-inbox.py`. The job
builds the PR server, starts `dist/server/standalone.js` on loopback with a
temporary config and file-published execution, and creates questions through
the owner route with its tailnet login header and UI handshake. The unmodified
released puller's `read_token` and `pull_once` use stub clavis and inbox commands
to GET bridge work and POST captures, replies and errors. The test imports these
functions to use loopback HTTP, bypassing only the CLI's HTTPS-origin argument
check; it does not emulate TLS or macOS launchd.

Assertions read the same owner API as the Desk Ask panel. They cover a plain
answer, structured content with an invalid action and unsafe reference, capture
and wake failures, and an empty repeat pass. For updated pullers they also check
the warning inbox receipt and replayed POST warnings. State, credentials and command PATH
are private; telemetry downloads and reach are disabled, with no real Notion,
clavis or First Mate calls. Any failure exits nonzero and fails the job.

Run locally after `npm ci`:

```sh
npm run build:server
npm run test:published-puller
```

At each release, extract `package/scripts/ask-puller.py` from the **released
package** into a new version directory. Read `package/package.json` in that
archive to verify the release version, compute the script's `sha256sum`, and
update both fields in `latest.json` and append the version/digest to
`supported.json`. Run the commands above and commit the new
fixture and manifest together. Do not copy the repository's current script.
Keep older fixtures while those installed clients remain supported. Both the
HTTP suite and built-server CI run every entry in `supported.json`, including
unversioned 6.0.0. The 6.0.1 fixture is extracted from the release tarball
prepared for the one-time Mac bootstrap upgrade, not copied from source.
Tin Star is distributed by tarball; no npm registry publication is needed.
