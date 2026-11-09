# Open in ChatGPT

Overview work cards and PR Operations rows have an **Open in ChatGPT** icon beside
Ask and Inspect. Click it, or focus it and press Enter/Space, to open a new ChatGPT
tab. Tin Star also shows the exact prompt in a copy dialog. If the browser blocks
the tab, or ChatGPT/app interception loses the prefill, choose **Copy prompt** and
paste into a new conversation. When clipboard access is denied, the visible text
is selected for the device's Copy command. Review the text before sending.

The deterministic prompt identifies the exact work item or canonical repository
and PR number, includes stable Notion/GitHub and Tin Star links, and asks neutrally
to discuss it. Work includes observed status, owner, initiative/epic, source read
timestamps/coverage and declared PR links. PRs include observation timestamps,
head, existing active work associations and CI only when read for that head;
unread checks remain unknown and retained evidence is labeled stale. Linked work
is not inferred from titles or worker proximity.

Only bounded metadata is selected. Card/PR bodies, customer fields, credentials,
raw logs and source error text are not serialized. Recognizable credential strings,
email addresses and URLs embedded in metadata are redacted; this is not a general
sensitive-data classifier, so titles and other selected metadata must themselves
be suitable for sharing. Source URLs are reconstructed canonically, and Tin Star
links discard current query parameters, fragments and URL credentials. Prompts
are capped at 1,800 characters and encoded URLs at 6,000 characters.

`openInChatGPT` in `src/ask/chatgptContext.ts` is a pure typed context builder.
`OpenInChatGPT.tsx` owns the browser navigation and copy recovery. Neither invokes
First Mate nor writes Tin Star source state. Existing Ask, Inspector, row selection,
expansion and swipe controls keep their behavior. Movement on the new action
cancels activation. Workers, releases and Smart Search are outside this slice.

## Browser verification limits

`https://chatgpt.com/?prompt=` is an undocumented best-effort browser convenience,
not an OpenAI API contract. The complete prompt is encoded with
`encodeURIComponent`; no auto-submit parameter or internal API is used. The
visible copy dialog is always available because Tin Star cannot inspect a
cross-origin ChatGPT tab to detect lost prefill.

On November 9, 2026, isolated Chrome desktop and 390px mobile/touch emulation
attempts with both `?q=` and `?prompt=` reached a Cloudflare security challenge.
Neither prefill nor edit-before-Send behavior could be established without going
beyond that boundary. No ChatGPT login or send was performed. The `prompt` form
is therefore tentative; this environment supplies no evidence that either form
prefills successfully. The copy/paste path remains available independently.
Actual Android Chrome, mobile Safari/WebKit and native ChatGPT app interception
require a device check; Chrome viewport/user-agent emulation does not prove them.

Future conversation-link persistence is separate work. This action does not
capture a canonical `/c/…` URL or reopen an existing ChatGPT conversation, and does
not depend on a Tin Star MCP tunnel. The prompt can request richer live context
from Tin Star MCP when it is connected.
