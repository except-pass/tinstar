# Published Ask puller

`6.0.0/ask-puller.py` is the unmodified script from the released Tin Star 6.0.0 package (`package/scripts/ask-puller.py`).
Its SHA-256 is `91aa6cd9674313abdd1e6966410c2dcb66f38a6c489fbea2e992a21a321aae4e` (provenance only, not a runtime gate).
The Ask HTTP contract test in `src/server/ask/__tests__/ask.test.ts` executes this installed client to catch server changes that would break existing Mac pullers, including content rejection that makes an entire pass incomplete.

At each release, copy the script from the released package into a new version directory, record its version and SHA-256 here, and update the latest-published compatibility test to execute it.
Keep older fixtures while those installed clients remain supported.
