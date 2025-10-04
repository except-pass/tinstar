# Backend implementation guide

## 1) What the frontend expects (contract)

Return this **single payload** to feed the UI:

```ts
// SlashCommandData (same shape the UI already uses)
type CommandRecord = {
  id: string
  name: string
  description?: string
  aliases?: string[]
  tags?: string[]
  allowedTools?: string[]
  source?: "project" | "user" | "sdk"
  path?: string
  version?: string
  createdAt?: string
  updatedAt?: string
}

type CommandsIndex = {
  byId: Record<string, CommandRecord>
  order: string[] // array of ids (display order)
}

type UserPrefs = {
  starred: string[]
  recent: string[]
}

type SlashCommandData = {
  index: CommandsIndex
  prefs: UserPrefs
}
```

## 2) Endpoints

**GET `/api/commands`** → `SlashCommandData`

* Uses the current authenticated user to fetch `prefs`.
* Query param: `?forceReload=1` (optional) to bust caches.

**PATCH `/api/prefs`** (JSON body with partial updates)

```json
{ "starred": ["c1","c3"], "recent": ["c2","c1"] }
```

* Merge semantics: when present, replace the whole array (frontend already sends the full list).
* Auth required; prefs are per-user.

**POST `/api/execute`**

```json
{ "commandId": "c1", "args": "id=42 verbose=1" }
```

* Resolve the command, enforce `allowedTools`, substitute `$ARGUMENTS` in the prompt, and kick off an Agent SDK run.
* Return `{ runId: "…" }`, and stream progress/results over SSE/WebSocket, or return the final result if you don’t need streaming.

**GET `/api/execute/:runId/stream`** (SSE optional)

* Streams tokens/status back to the client.

## 3) Command loader (server)

Load from these sources (highest precedence first):

1. **Project**: `<repo>/.claude/commands/**/*.md`
2. **User**: `~/.claude/commands/**/*.md`
3. **SDK/Static**: shipped defaults (optional)

**Parsing rules**

* Use `gray-matter` to parse YAML front-matter.
* `name` = `"/" + relative/path/without-ext` (namespaces via folders).
* `description` = `frontMatter.description` OR first `# Heading` OR first non-empty line.
* `aliases` = `frontMatter.aliases` (array of strings like `"/trace"`).
* `tags` = `frontMatter.tags` (array of strings).
* `allowedTools` = `frontMatter.allowedTools` (array of strings).
* `version` = content hash (sha256 of normalized front-matter + body).
* `id` = sha256 of `${source}:${name}:${version}` (stable across reloads).

**Merging**

* Key by **name**; sources are applied in precedence order (project > user > sdk).
* If same name exists, the higher-precedence one wins.
* Produce `index.byId` and an `order` array (default alpha by `name`).
  Optional: support `frontMatter.order` (number) to sort first by order then alpha.

**Hot reload**

* Watch both directories with `chokidar`.
* On change, rebuild the in-memory index and bump a `revision` counter.
* Notify connected clients via SSE `event: commands:update` (optional).

**Safety**

* Only read whitelisted dirs; reject symlinks escaping the roots.
* Size limits on MD files (e.g., 64KB) and front-matter.

### Example loader (sketch)

```ts
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import crypto from "crypto";
import chokidar from "chokidar";

type Source = "project" | "user" | "sdk";

const projectDir = path.join(process.cwd(), ".claude", "commands");
const userDir = path.join(process.env.HOME || "", ".claude", "commands");

function sha(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
}

function scan(root: string, source: Source): Array<{name: string; record: Omit<CommandRecord,"id"> & {name: string}}> {
  if (!root || !fs.existsSync(root)) return [];
  const files: string[] = [];
  (function walk(d: string) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && /\.md$/i.test(ent.name)) files.push(p);
    }
  })(root);

  return files.map(file => {
    const raw = fs.readFileSync(file, "utf8");
    const { data, content } = matter(raw);
    const rel = path.relative(root, file).replace(/\\/g, "/").replace(/\.md$/i, "");
    const name = "/" + rel;
    const bodyFirstLine = content.split(/\r?\n/).find(l => l.trim());
    const header = content.match(/^#\s+(.+)$/m)?.[1];

    const description = typeof data.description === "string"
      ? data.description
      : (header || bodyFirstLine || "").trim();

    const aliases = Array.isArray(data.aliases) ? data.aliases : undefined;
    const tags = Array.isArray(data.tags) ? data.tags : undefined;
    const allowedTools = Array.isArray(data.allowedTools) ? data.allowedTools : undefined;

    const norm = JSON.stringify({ data: { description, aliases, tags, allowedTools }, content });
    const version = sha(norm);

    const record = {
      name,
      description,
      aliases,
      tags,
      allowedTools,
      source,
      path: file,
      version,
      updatedAt: new Date().toISOString(),
    };

    return { name, record };
  });
}

export function loadCommands(): CommandsIndex {
  const merged = new Map<string, Omit<CommandRecord,"id"> & {name: string}>();

  // precedence: project > user > sdk
  for (const { root, source } of [
    { root: projectDir, source: "project" as const },
    { root: userDir, source: "user" as const },
  ]) {
    for (const it of scan(root, source)) merged.set(it.name, it.record);
  }
  // add SDK/static defaults if you want
  // for (const it of sdkDefaults) merged.set(it.name, it.record);

  // finalize ids + order
  const byId: Record<string, CommandRecord> = {};
  const temp: Array<CommandRecord> = [];
  for (const rec of merged.values()) {
    const id = sha(`${rec.source}:${rec.name}:${rec.version}`);
    temp.push({ id, ...rec });
  }
  temp.sort((a,b) => a.name.localeCompare(b.name));
  for (const r of temp) byId[r.id] = r;

  return { byId, order: temp.map(r => r.id) };
}

export function watchCommands(onReload: (idx: CommandsIndex) => void) {
  const watcher = chokidar.watch([projectDir, userDir].filter(Boolean), { ignoreInitial: true });
  watcher.on("all", () => onReload(loadCommands()));
  return watcher;
}
```

## 4) Persistence: user prefs

If prefs must survive server restarts or be shared across devices, store them in a DB.

**PostgreSQL schema (simple)**

```sql
create table user_command_prefs (
  user_id uuid primary key,
  starred_ids text[] not null default '{}',
  recent_ids  text[] not null default '{}',
  updated_at timestamptz not null default now()
);
```

* `starred_ids`/`recent_ids` hold **command IDs** (not names).
* Enforce max sizes in code (e.g., `recent` capped to 20).

**DAO (sketch)**

```ts
async function getPrefs(userId: string): Promise<UserPrefs> { /* SELECT ... */ }
async function savePrefs(userId: string, prefs: UserPrefs) { /* UPSERT ... */ }
```

## 5) Execution path (Agent SDK)

**Permission enforcement**

* When you create your Agent, wire a `canUseTool` (or equivalent) permission hook.
* Look up `commandId → CommandRecord.allowedTools`; if present, only allow those tools for the lifetime of that run. Thread the active command into session metadata so the permission hook can check it.

**Run flow**

1. Look up `CommandRecord` by `commandId`.
2. Read the Markdown body (server has `path`), perform `$ARGUMENTS` substitution with the raw `args` string.
3. Compose a system/user message and call the Agent SDK.
4. Stream output via SSE/WebSocket; include minimal status updates (`started`, `tool_call`, `token`, `done`).

**SSE skeleton**

```ts
app.get("/api/execute/:runId/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const send = (t: string, d: any) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);

  // attach to your run event emitter by runId
  runs.on(req.params.runId, (evt) => send(evt.type, evt.payload));
  req.on("close", () => runs.off(/* ... */));
});
```

## 6) API examples

**GET /api/commands → 200**

```json
{
  "index": {
    "byId": {
      "c1hash": { "id":"c1hash", "name":"/debug-trace", "description":"Trace FE → API → gRPC → DB...", "allowedTools":["Bash(*)","mcp__influx__query","Edit"], "source":"project", "path":"/repo/.claude/commands/dev/debug-trace.md", "version":"e5ac..."},
      "c2hash": { "id":"c2hash", "name":"/gen-command", "description":"Scaffold a new /command...", "source":"project", "version":"a19e..." }
    },
    "order": ["c1hash","c2hash"]
  },
  "prefs": { "starred": ["c1hash"], "recent": ["c2hash","c1hash"] }
}
```

**PATCH /api/prefs (body)**

```json
{ "starred": ["c1hash","c3hash"], "recent": ["c2hash","c1hash"] }
```

**POST /api/execute (body)**

```json
{ "commandId": "c1hash", "args": "url=/v1/users?id=42 verbose=1" }
```

**→ 200**

```json
{ "runId": "run_01JJ..." }
```

## 7) Tests to add (server)

* **Loader**

  * Parses front-matter correctly (description/aliases/tags/allowedTools).
  * Name = folder-namespaced path → `"/dev/debug-trace"`.
  * Precedence rules (project overrides user).
  * ID stability (unchanged when mtime changes but content is same).
* **Prefs**

  * Star/unstar roundtrip with DB.
  * Recent MRU cap size.
* **Execution**

  * `$ARGUMENTS` substitution.
  * `allowedTools` enforcement rejects disallowed tool invocations.
  * SSE/WebSocket lifecycle and cleanup on disconnect.

## 8) Security & multi-tenant notes

* Resolve the **user** from your auth layer and use it for prefs scoping.
* If running server-side outside users’ machines, **do not** read `~/.claude/commands` on the server; only use project commands (or a per-user upload path). The “user” directory approach is for local desktop apps.
* Validate `args` size (e.g., 8–16 KB max), and sanitize if you interpolate into shell commands (ideally, you don’t — use tools safely from the Agent SDK).
* Log and rate-limit `/execute`.
