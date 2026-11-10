# Local voice questions

The same First Mate composer appears in Desk threads, the Overview Inspector
(cards, workers and connections), worker terminal details, PR details and Releases details. Compact rows
keep their existing Ask icons, semantic right-click and swipe gestures. Typed
questions use Enter to send and Shift+Enter for a newline.

Hold **Talk** to record and release to transcribe and send. A short tap starts
recording; the next tap stops and sends. Keyboard/screen-reader activation uses
the same toggle. The recording state shows elapsed time, a red microphone and
**Cancel recording**. Cancel, recording loss, navigation away and a hidden page
stop capture and never send a question. Browser capture stops automatically at 59s to leave encoder headroom within the
60s server limit.
Allow microphone access on an HTTPS Tin Star origin (localhost also works).
The browser selects the first supported format from WebM/Opus, MP4 and
Ogg/Opus, falling back to its default recording format.

Transcribed speech is appended to the existing draft and automatically sent as
an ordinary question through the existing idempotent Ask protocol. In a Desk
thread it retains that conversation and previous-turn context. The transcript
appears in history; if sending fails it stays editable in the composer and Send
retries the exact same request. If transcription fails or times out, the draft
is preserved. Type instead or record again. No audio upload is automatically
retried. A draft that would exceed 4,000 characters stays editable and requires
shortening before Send.

## Installation and updates

Install Tin Star normally with Node >=22.12 on Linux or macOS. On the **server
running Tin Star**, the guarded floor deploy installs the local English model
after building, then prints voice status. Installation is idempotent. Download
or status failures warn clearly and continue the deploy; text input stays
available. For other installations, enable local English transcription once:

```sh
tinstar voice install
tinstar voice status
```

This supported Tin Star command downloads the publisher's English Whisper
`tiny.en` q8 model (about 42 MB) into `getConfigRoot()/voice/`. No model binaries
are committed or included in the npm tarball. The installer verifies the
published asset SHA-256 values in `bin/voice/model.json` to detect interrupted or
corrupt downloads. A failed install can be retried with the same command.
Normal npm updates refresh an already enabled voice installation on Linux and
Mac; no Homebrew/Python/CMake or external provisioning scripts are needed.
`TINSTAR_CONFIG_HOME` selects an isolated installation. Unconfigured clients do
not download a model during updates. No inference occurs during installation,
startup or idle polling. Missing model/runtime errors tell users voice input is temporarily unavailable
and keep their draft available for typing. They never show server commands. A
missing model at request time opens one labeled SYSTEM VOICE MODEL NOTICE to
First Mate through the existing Ask bridge/outbox, deduped across clicks and
restarts until a request sees the model available again. The existing watchdog
delivery setting also suppresses these notices on previews. No new scheduler
or store is used.

`@huggingface/transformers` provides ONNX CPU inference. `ffmpeg-static` provides
the platform audio decoder during npm installation (its bundled binary and
license are maintained by that package). Production installs must permit
normal npm dependency install scripts so the platform decoder is present.

## Boundary, resource use and retention

`POST /api/ask/transcribe` accepts raw audio only after the same loopback peer,
tailnet owner, origin and UI handshake checks as Ask. The browser never sees a
bridge token. Keep the backend bound to loopback behind the existing tailnet
HTTPS owner boundary; see [Ask setup](ask.md). This route returns a transcript,
never creates an owner Ask turn itself, and uses no remote inference provider.
Only a missing-model system notice uses the existing Ask delivery store/bridge.

Uploads are limited to 8 MiB and WebM, MP4, Ogg or WAV containers, with matching
container signatures. FFmpeg additionally validates actual decodability and
decoded duration (maximum 60 seconds). Its only permitted input protocol is an
in-memory pipe, preventing audio containers/playlists from fetching URLs or
reading local files. Decoded PCM is bounded at 61s so a compressed long upload
cannot expand without limit. One recording is admitted per server process;
concurrent callers get a visible busy response, with no audio waiting queue.

The decoder and inference run in a short-lived process group at low priority,
with one CPU inference thread and a 90s overall deadline including upload. A
client cancellation/disconnection terminates that process group, including the
decoder. Raw audio and PCM exist only in bounded memory: no temp file, upload
folder, raw-audio history or decoder/audio logs. Child diagnostics are discarded;
only the transcript is returned to the browser. Remote model fetching is disabled
at inference time. There is no paid speech API, remote transcription fallback,
always-on microphone, background model server or idle model inference.

Initial Hulk measurements: cold startup 0.57–0.75s, inference 0.75–1.01s for
3.8–11s clips at one CPU thread; human JFK smoke clip matched its reference,
while synthetic speech had small wording errors. These are smoke measurements,
not a guarantee of accuracy for names, accents, background noise or every phone.

## Proof before deployment sign-off

Focused tests cover capture hold/toggle, cancellation, late permissions,
recording loss, insecure origins, denial, failed/empty transcription, draft
preservation, auto-send correlation, upload authorization and resource bounds.
Existing conversation/action/reply tests continue to cover bridge correlation,
idempotency, immutable replies, old records and bounded history.

Firstmate owns post-deploy real iPhone Safari/Android Chrome and First Mate
reply proof: record a pronoun-dependent follow-up in an existing Desk thread;
check the actual delivered envelope and reply, stable conversation ID/history
across reload/device/section changes; test hold/tap/cancel/denial/airplane mode,
keyboard visible at 390px, reduced motion and return-to-source. Screenshots and
fake-media desktop proof do not substitute for those physical device checks.
