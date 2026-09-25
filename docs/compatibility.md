# Pi Compatibility

SoL-Pi is developed and tested against `@earendil-works/pi-coding-agent` 0.85.1 and remains compatible with the originally supported 0.84.2 release. The current 23 test files (219 tests), type checking, package inspection, public API checks, and offline extension startup passed on both releases. Previous checks covered the public API surface of Pi 0.81.1, the base used by the original Pi fork; they are not a current full-suite compatibility guarantee. The runtime range is deliberately expressed as a peer dependency because Pi owns installation and upgrade of its packages; it is not a guarantee for every Pi version.

SoL-Pi imports only public package exports:

- `createEditToolDefinition`
- `createWriteToolDefinition`
- `createBashToolDefinition`
- extension types and `ExtensionAPI.registerTool`
- `context`, `before_provider_request`, `tool_result`, `turn_end`, `agent_settled`, and `session_before_tree` extension events
- native compaction events, `ExtensionContext.getContextUsage()`, and `ExtensionContext.compact()`
- `ExtensionContext.model` and `ExtensionContext.modelRegistry`
- the public session-manager methods exposed through `ExtensionContext`

## Action Fusion

The built-in edit/write definitions capture their working directory, so SoL-Pi caches one definition per `ctx.cwd`. The fused tool keeps the built-in's metadata and replaces its execute with a delegation to that same built-in, and its own queue surrounds the delegated mutation and the follow-up command. It does not nest Pi's built-in mutation queue.

Where the host publishes its registered tools (`getAllTools()`) and binds a delegation entry point (`ctx.invokeTool()`), the fused schema is the host's own schema for that tool plus `then_run`, and the mutation runs through the host's entry point, so the session's edit store, device dispatch, approvals, and settings apply to a fused call. A host without that surface composes the same definition itself and calls it directly.

The host may resolve the built-in `edit` parameter shape per session and publish it only after extension loading. SoL-Pi therefore corrects the advertised shape from the host's own resolution: the built-in `edit` schema answers while the host still publishes it, and otherwise the `read` tool does, because its published description names the patch-language anchors only in that variant and no SoL-Pi mechanism replaces it. A pinned `PI_EDIT_VARIANT` decides the variant outright, and a host that publishes neither signal keeps the shape already advertised. Both hooks that run before the host serializes a request attempt the correction — `session_start` for hosts that load extensions first, `before_agent_start` for hosts that load them afterwards — and the host reads the fused tool's schema and description per request, so the corrected shape reaches the model without re-registering the tool.

Action Fusion decodes `file://` targets with Node's `fileURLToPath()` before resolving the queue and hash-check path. This keeps file URLs, including percent-encoded filenames and Pi's optional `@` prefix, aligned with the file handled by the built-in mutation tool. A call that names no single file — a patch whose targets live in the patch text, or a device write such as `xd://resolve` — takes a working-directory-wide queue slot and hash-checks every path the mutation reports in its result details (`path`, `perFileResults[].path`), skipping the check when it reports none.

The queue covers only fused operations registered by this SoL-Pi instance. External processes, direct built-in-tool calls outside the replacement, and unrelated extensions are not globally locked. SoL-Pi hashes the target immediately before launching `then_run` and skips the command if it observes an intervening content change.

## ObservationPack

ObservationPack changes only the messages projected through the public `context` event. Stored session history remains intact. Original bytes and the JSONL ledger live under the session-derived SoL-Pi directory.

## Evidence-Preserving Reducer

The reducer handles public `tool_result` events and resolves the configured reducer provider/model through Pi's model registry before calling `ExtensionContext.modelRegistry.complete()` when available. For the Pi 0.81.1 fork, which exposes no registry `complete()` method, it resolves authentication for that reducer model through `getApiKeyAndHeaders()` and calls the shared `@earendil-works/pi-ai/compat` completion API. The reducer preserves the original result whenever the configured reducer model is unavailable or eligibility, model-call, schema, source-hash, exact-quote, size, or likely-secret checks fail.

All persistent paths use `SessionManager.getSessionDir()` and `getSessionId()`, which are present in both the fork and Pi 0.85.1. SoL-Pi creates no configurable storage-path surface.

The unpublished shared artifact layout is not read or migrated. Each session starts from its own `<sessionDir>/sol-pi/<sessionId>/` directory.

## Online Context Compact

Online Context Compact uses ordinary public `context` and `before_provider_request` handlers instead of fork-only post-transform observer methods. Public handlers run in extension load order, so the SoL-Pi entrypoint registers Online Context Compact after its other context transformers. A third-party transformer loaded later is outside the context-growth observation used by its estimate.

Pi does not expose its active retained-tail compaction setting through the public extension context. The standalone extension therefore uses the Pi 0.85.1 default of 20,000 tokens for its economic estimate. Its programmatic factory accepts an explicit matching value for a non-default Pi setting.

Pi 0.85.1's `ExtensionContext.compact()` aborts the active agent before it summarizes, and `agent_settled` fires only once a whole run has drained every turn, retry, auto-compaction, and queued continuation. A plan boundary that selects compaction therefore saves its plan and progress state, calls `ExtensionContext.abort()` to stop the run, and runs compaction from the `agent_settled` that stop produces. The handler awaits the compaction's own `onComplete`/`onError` callbacks. On success, the extension sends a hidden reminder through public `ExtensionAPI.sendMessage()` with `triggerTurn: true`, so Pi starts a new turn against the compacted context and rebuilds the plan even when the native summary omits that instruction.

A settlement barrier keeps the original `agent_settled` dispatch open until the triggered continuation settles. Print- and JSON-mode processes therefore complete the compact-and-continue sequence within the same Pi invocation; an outer driver does not need to resume the session or send `Continue working`. This continuation is armed only by a successful boundary compaction. Cancelling or exiting does not schedule one. A Pi build that never emits `agent_settled` starts no boundary compaction.

Pi 0.85.1 does not return a promise from `ExtensionAPI.sendMessage()`. The barrier is therefore verified for standalone SoL-Pi and depends on Pi starting the requested turn synchronously. A later-loaded third-party extension that performs long asynchronous work in its own `agent_settled` handler is outside this guarantee and needs an integration test with that extension set.

Pi reports the session as idle while an extension-requested manual compaction is running. SoL-Pi cancels `session_before_tree` during that interval to prevent tree navigation from moving the active leaf underneath the compaction. Navigation works normally after the compaction callback settles.

Online Context Compact reads `ExtensionContext.getContextUsage()` for both the context window and the provider-counted context size. When Pi reports no size — as it does between a compaction and the next answered request — the boundary falls back to its own estimate.

The standalone entry passes `cacheWriteReadRatio` from `sol-pi.json` into Online Context Compact's economic check. With the `"auto"` default the check reads the serving model's API list prices from `ExtensionContext.model` (`Model.cost.input`, `Model.cost.cacheRead`, and `Model.cost.cacheWrite` — the same fields Pi's own cost accounting uses) and derives the write/read price ratio per decision, so a mid-session model switch is picked up. The write side is the model's cache-write rate, or its input rate when the rate card lists no separate write rate; a zero write rate is a rate-card statement, not a free write. Pi 0.85.1 exposes those fields, so no host gate is needed. Models with a zeroed or missing cache-read price — Pi's catalog row for unknown pricing — keep the `12.5` fallback. A configured number bypasses the derivation, and changing it still requires a new session.

## Interactive TUI

The lightning savings treatment uses Pi 0.85.1's public `renderCall`,
`renderResult`, `ctx.ui.notify()`, and keyed `ctx.ui.setStatus()` APIs. It checks
`ctx.mode === "tui"` rather than `ctx.hasUI`, because RPC mode also reports UI
support. The renderer therefore changes only the interactive terminal display;
it does not change session messages, provider requests, tool results, JSON
events, print output, or RPC UI requests.

## Oh My Pi (omp)

Oh My Pi loads Pi extensions through a compatibility layer that rewrites the
`@earendil-works/*` package specifiers and the bare `typebox` import onto its own
copies. A number of host surfaces still differ, so `src/sol-pi/host-compat.ts`
inspects the values the host passes instead of assuming Pi's shape:

- `ExtensionContext.compact()` is callback-only and returns `void` on Pi. omp
  returns a promise that settles after the summary is committed, reads the
  summarizer guidance as `internalGuidance` instead of `customInstructions`, and
  can suppress the resume it would otherwise run for the turn the compaction
  interrupted. SoL-Pi sends both field names and completes on whichever signal
  the host produces.
- Built-in parameter schemas are TypeBox objects with a `properties` map on Pi,
  while omp's built-ins expose callable omptype schemas whose document is
  reachable only through `toJsonSchema()`. Spreading `parameters.properties`
  there produced fused `edit` and `write` schemas containing only `then_run`, so
  every file mutation reached the model without `path` or `content`. The fusion
  helper now rebuilds the schema from the JSON Schema document and preserves
  `required` and `additionalProperties`.
- Host action methods refuse calls while extensions load: `getAllTools()` throws
  `Extension runtime not initialized. Action methods cannot be called during
  extension loading.` until the session starts, and a `registerTool()` call
  replaces the registry entry of the name it takes, so a replacement cannot read
  the built-in schema it replaced. `registerTool()` also takes effect only during
  loading — a registration from a session event leaves the earlier definition in
  place — while the host reads a definition's `parameters` and `description` on
  every request. The fused `edit` therefore publishes both as accessors and its
  `session_start` and `before_agent_start` handlers rewrite the advertised shape
  in place once the variant is readable; the host serializes a request before
  `turn_start`, so those two hooks are the last ones that can land in the same
  turn. `sessionEditVariant()` reads the variant from the built-in `edit` schema
  while omp still publishes it and otherwise from the `read` tool's published
  description, which omp renders from the same edit-mode resolution.
- `PI_EDIT_VARIANT` names the edit variant outright in omp's own resolution, and
  its edit factory reads the same variable when it constructs a definition.
  `editDefinitionForVariant()` sets it for that synchronous construction and
  restores the previous value before returning.
- The definitions returned by the legacy `createEditToolDefinition()` and
  `createWriteToolDefinition()` factories run on a synthetic session carrying
  only `cwd`, a session file, and isolated settings. A tool re-registered
  through them therefore reaches neither the session's edit store nor its
  `xd://` devices, so a `write xd://resolve` call issued through such a tool
  cannot see a pending preview action. omp binds `ctx.invokeTool()` on a tool
  that re-registers a built-in of the same name, and that call runs the native
  built-in with the agent loop's own tool context; SoL-Pi delegates through it
  and keeps the composed definition for hosts without it.
- Tool renderers are called as `renderCall(args, theme, context)` and
  `renderResult(result, options, theme, context)` on Pi, and as
  `renderCall(args, options, theme)` and `renderResult(result, options, theme,
  args)` on omp. omp's built-in definitions also carry no renderers at all, so a
  fused tool falls back to its own title line instead of calling into a renderer
  that does not exist. omp stacks a tool's call row above its result row unless
  the tool declares `mergeCallAndResult`, so SoL-Pi's tools declare it and the
  result row replaces the call row instead of repeating the badge; Pi's
  renderer has no such flag and ignores it.
- `ExtensionContext.getSystemPrompt()` returns one string on Pi and the prompt's
  lines on omp; token accounting joins the lines.
- Pi renders a tool's `promptSnippet` and `promptGuidelines` into its system
  prompt. omp declares `promptGuidelines` but never reads it and has no
  `promptSnippet` field, so on omp the same guidance is appended to the tool
  description instead of being dropped: `obs_recall` carries its retrieval hint
  and `update_plan` its three plan rules. Action Fusion's `then_run` guidance
  already travels in the parameter description on both hosts.
- A session without a persistent session directory (omp `--no-session`) skips
  archiving rather than failing the request it is handling. `obs_recall` reports
  that nothing was stored.

- omp enforces a per-tool approval tier (`read`/`write`/`exec`) and defaults an
  undeclared tool to `exec`. The fused `edit`/`write` declare a function-valued
  approval: a call carrying `then_run` resolves to `exec`, because it runs a
  shell command, and any other call defers to the built-in's own declaration.
  `obs_recall` declares `read` and `update_plan` declares `write`, so tightening
  `tools.approvalMode` does not prompt for a read-only recall. Pi's
  `ToolDefinition` has no `approval` field and ignores the declaration.
- omp truncates an oversized bash result inline and stores the full bytes as a
  session artifact instead of Pi's `details.fullOutputPath`. A truncated result
  names the artifact in `details.meta.truncation.artifactId` and in the
  `Read artifact://N for full output` notice; a result the bash minimizer
  rewrote into a lossy summary carries no metadata and names it only in the
  trailing `[raw output: artifact://N]` footer. Evidence-Preserving Reducer
  resolves either id through `SessionManager.getArtifactPath()` and checks
  evidence against the full output, as on Pi. When the artifact cannot be read
  it skips the result and journals `full-output-unavailable` rather than
  reducing the truncated preview. Observation Pack archives the same resolved
  original when such a result exceeds its packing threshold.
- omp's `ExtensionContext` has no `signal` member. The reducer's model call is
  bounded by its own timeout there, and Online Context Compact's `turn_end`
  guard relies on the message stop reason; neither reads a host abort signal
  that does not exist.
- omp never emits `agent_settled`: the event is absent from its event list, and
  registering it is accepted but never fires. The settle trigger is therefore
  unreachable on omp, which is why boundary compaction keys off managed timers
  instead. Host detection probes two members omp adds to the context — managed
  timers and the read-only `models` query — so a future Pi that adopts one of
  them is not misclassified.
- omp's `input` event has no `streamingBehavior`, so a steer cannot be named
  directly. Online Context Compact treats user input that arrives while the run
  is active (`isIdle()` is false) as the steer; extension-originated messages,
  including its own post-compaction continuation, never count. omp cannot tell
  a queued follow-up from a steer, so a follow-up sent mid-run is also recorded
  as a correction — the safe direction for plan invalidation.
- omp's `ModelRegistry` has no `complete()` method; the reducer always
  authenticates through `getApiKeyAndHeaders()` and calls the shared
  `@earendil-works/pi-ai/compat` completion API on omp. That is the supported
  path, not a fallback: omp's auth answer carries no `baseUrl`, so the reducer
  takes the provider's configured base URL from `getProviderBaseUrl()`.
- `renderShell: "self"` has no omp counterpart; omp draws its own tool-row frame
  regardless, so the SoL-Pi title line composes with it. The fused
  `edit`/`write` rows are drawn by SoL-Pi's own argument-derived preview on omp,
  because omp ships no built-in renderers and stops applying its name-keyed
  renderer table once an extension takes the name.

Online Context Compact's trigger follows what the host can do with an interrupted
run:

| Host | Trigger |
| --- | --- |
| Pi | stop the run at the boundary, then compact from `agent_settled` |
| omp interactive and RPC | compact from a task scheduled after the `turn_end` handler returns, with the host's own resume suppressed and the SoL-Pi reminder starting the continuation turn |
| omp print and JSON | no boundary compaction |

omp tears a print or JSON session down as soon as an interrupted prompt settles,
which cancels an in-flight compaction and discards the rest of the run, so a
boundary in those modes is left alone; the host's own auto-compaction still
protects the context window. omp's `session_stop` hook is not used for
compaction: `compact()` aborts the settle path that hook belongs to, which
cancels the compaction and drops the continuation the hook would request.

Verified against Oh My Pi 18.2.6:

- extension load and tool registration (`edit`, `write`, `obs_recall`,
  `update_plan`) through omp's own loader, with no load errors;
- a fused write and a fused edit each running their mutation and `then_run`
  command in one tool call in a real print-mode session;
- ObservationPack replacing a 64 KiB tool result with its bounded placeholder
  after the configured number of provider requests, with objects and ledger
  written under the session directory;
- the evidence-preserving reducer applying a receipt (29,702 source bytes to a
  1,911-byte receipt carrying 7 quotations) through omp's model registry;
- boundary compaction and continuation through the deferred trigger in an RPC
  session, including a second consecutive boundary;
- omp print mode leaving a boundary alone while the run completes normally.

Verified against Oh My Pi 18.2.7, on the fused `edit`:

- a print-mode session whose model resolves the `replace` variant, with the
  model offered the host's single-file replacement schema plus `then_run`, and
  the mutation and its command running in one call;
- a print-mode session that resolves the `hashline` variant, with the model
  offered the host's patch-language schema plus `then_run`, and one `PUT` patch
  and its command running in one call;
- `write xd://resolve` finalizing a staged `ast_edit` preview inside a fused
  session, with the edit applied to the file.

Against Oh My Pi 18.3.x, `bun scripts/check-omp-compat.mjs` verifies the shim
surface directly in the installed omp package: every runtime export SoL-Pi
imports, the registry and session-manager capabilities the adaptation layer
branches on (`getApiKeyAndHeaders`, `getProviderBaseUrl`, `getArtifactPath`),
and the `.omp` configuration directories. The 18.2.7 → 18.3.x changelogs do not
touch any API surface SoL-Pi uses.

## Test doubles

The test suite drives every extension through the same public `ExtensionAPI` and `ExtensionContext` surface Pi provides, over a real public `SessionManager`, without calling a remote model provider. That keeps the suite zero-spend and independent of the deleted Pi monorepo test harness. Suites that need a genuine session tree — branch order, compaction entries, custom entries, resume — use `SessionManager.inMemory()` or `SessionManager.create()` rather than reimplementing them.

`tests/pi-package-integration.test.ts` loads the actual TypeScript entrypoint through Pi's `DefaultResourceLoader`, reads a trusted all-enabled project configuration, and executes a fused write/command and a plan update in a real `AgentSession`. `tests/online-context-compact-agent-session.test.ts` verifies one and two consecutive native compactions and waits for automatic continuation before the original prompt returns. These integration tests use Pi's deterministic faux provider; they verify runtime compatibility, not live provider authentication or token savings.

The 0.84.2 backward-compatibility run used an isolated copy of the current source and tests, separate dependencies, and an empty Pi agent directory. Only the copy's four Pi development dependency versions, lockfile, and installation-guide version mentions changed. No source or test changes were needed. The run included all four mechanisms and the native compaction/continuation integration tests; it did not repeat live-provider benchmarks on 0.84.2.
