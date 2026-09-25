# Configuration

SoL-Pi reads one effective JSON configuration file at extension startup. It uses Pi's public `CONFIG_DIR_NAME` and `getAgentDir()` APIs rather than assuming fixed directories.

## Search order

1. `<working-directory>/<Pi config directory>/sol-pi.json`, only after Pi marks the project trusted
2. `<Pi agent directory>/sol-pi.json`
3. Built-in defaults when neither file exists

For the official Pi distribution, the first two locations normally resolve to `.pi/sol-pi.json` and `~/.pi/agent/sol-pi.json`. On Oh My Pi they resolve to `.omp/sol-pi.json` and `~/.omp/agent/sol-pi.json`, because the extension reads those two directories from the host.

The project file replaces the global file. SoL-Pi does not merge them.

## Schema

```json
{
  "version": 1,
  "actionFusion": false,
  "observationPack": false,
  "evidencePreservingReducer": false,
  "evidencePreservingReducerProvider": "provider-id",
  "evidencePreservingReducerModel": "model-id",
  "onlineContextCompact": false,
  "cacheWriteReadRatio": "auto"
}
```

Feature keys may be omitted and then default to `false`. `cacheWriteReadRatio` may be omitted and then defaults to `"auto"`; when present it must be `"auto"` or a finite non-negative number. `"auto"` derives the ratio from the serving model's own API list prices — the price of the tokens a compaction rewrites into the cache, over the price of reading them back — and re-derives it on every decision, so a mid-session model switch changes the ratio. The rewritten tokens are priced at the model's cache-write rate, or at its input rate when the rate card lists no separate write rate: a zero write rate is not a free write, and subscription plans that meter no per-token price still draw down quota for those tokens. A model that exposes no cache-read price — the host catalog reports unknown pricing as a zeroed cost row — keeps the `12.5` fallback, which is the most expensive ratio in common use. A number pins the ratio for the session, and `0` explicitly means that a cache write adds no cost relative to a cache read. `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` may be omitted and then use the built-in reducer route; when present each must be a non-empty string. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid ratios, and invalid reducer model fields stop extension loading with a direct error.

For the managed all-enabled installation described in the [agent installation and configuration protocol](../agents-install.md), validate the effective file before starting Pi:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-all-enabled
```

This preflight does not make every valid SoL-Pi configuration all-enabled. Without `--require-all-enabled`, omitted feature keys retain their normal `false` defaults. The managed workflow uses the flag because its acceptance criterion is that all four mechanisms are active.

## Feature behavior

- `actionFusion`: registers SoL-Pi replacements for Pi's `edit` and `write` tools.
- `observationPack`: registers `obs_recall` and a provider-context projection handler.
- `evidencePreservingReducer`: registers a `tool_result` handler and delegates long diagnostic-log reduction to the configured reducer provider/model.
- `evidencePreservingReducerProvider`: provider namespace used to resolve the reducer model through Pi's model registry.
- `evidencePreservingReducerModel`: model id used for Evidence-Preserving Reducer.
- `onlineContextCompact`: registers `update_plan` and boundary-driven native compaction after the other SoL-Pi context transformers.
- `cacheWriteReadRatio`: supplies the economic decision ratio used by Online Context Compact — `"auto"` from the serving model's cache prices, or a fixed number.

## Evidence-Preserving Reducer runtime inputs

The release entry supplies the run label and session-derived storage. It uses one configurable model route:

- **Reducer provider/model** — from `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` in the effective `sol-pi.json`. If omitted, SoL-Pi uses its built-in reducer route. SoL-Pi resolves that model through Pi's model registry and still relies on Pi-managed authentication; do not put credentials in `sol-pi.json`.

## Online Context Compact runtime inputs

The release entry uses two runtime inputs:

- **Context window** — from `ExtensionContext.getContextUsage()`, used for window-pressure protection.
- **Cache write/read ratio** — resolved per decision from `cacheWriteReadRatio` in the effective `sol-pi.json` and `ExtensionContext.model`. `"auto"` uses the serving model's API list prices and follows a mid-session model switch; a configured number stays fixed. It drives one runtime decision and is not a cost report.

A configured numeric ratio stays fixed for the loaded extension; `"auto"` re-reads the serving model's API list prices on every decision. The mechanism stores its current plan, progress summaries, request horizon, context growth, and compaction debt as versioned custom entries in Pi's session log. A snapshot that fails to parse is not treated as a fresh session silently: the newest readable snapshot wins instead, and the session surfaces a warning naming the number of corrupt snapshots. After a successful compaction it sends one hidden, generic message with `triggerTurn: true`, which starts a new turn and instructs the assistant to rebuild its plan. A settlement barrier keeps print and JSON modes in the same Pi invocation until that continuation settles, so callers do not need to resume the session or inject `Continue working`. Cancelling or exiting does not schedule an automatic continuation. The programmatic factory exposes only a matching retained-tail value for installations whose Pi compaction setting differs from the default.

### Compaction gate and audit

At a completed plan boundary the mechanism compacts when either of two gates opens:

- **Window protection** — the estimated context is within 16,384 tokens of the model's context window.
- **Economics** — rewriting the context pays for itself within the estimated remaining requests. A compaction rewrites `writeTokens` into the cache once and saves `archiveTokens − memoTokens` from every subsequent prompt, so the breakeven is `writeTokens × (ratio − 1) / (archiveTokens − memoTokens)` requests. The horizon estimate comes from the completed boundaries' request intervals; the first compaction of a session is granted a doubled horizon, and later compactions additionally require a 1.5× margin and that the carried cache debt also break even.

Worked example, recorded in a real session: a model listing $0.50/M input tokens (no separate cache-write rate) and $0.01/M cache-read tokens resolves `"auto"` to a ratio of 50, so the rewrite is priced at 49 reads per token. With a 118k-token context the breakeven lands at ≈68 requests; the horizon estimate starts at 67 requests and the first-compaction doubling makes it 134 — the boundary compacts with room to spare. A model whose write and read prices are close resolves a ratio near 1, the breakeven collapses toward zero, and the economic gate opens at almost every boundary.

Every boundary evaluation appends one JSONL `decision` record — the full gate inputs plus `compact` and the `reason` — and every selected compaction appends one `outcome` record to `<session directory>/sol-pi/<session id>/online-context-compact/decisions.jsonl`. A boundary that did not compact is therefore distinguishable from one that never ran, and a recorded `deferred_economic` decision explains itself through its breakeven and horizon fields. Sessions without a persistent directory (omp `--no-session`, Pi print without a session file) keep no journal.

## Pi integration

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer resolves its configured reducer provider/model through `ExtensionContext.modelRegistry` and uses Pi-managed authentication. If the configured reducer model is unavailable or the nested model call fails, the original tool result continues unchanged.

SoL-Pi does not configure shell paths, command prefixes, storage paths, run IDs, provider URLs, reasoning levels, timeouts, or per-mechanism enable flags through environment variables. Apart from the EPR reducer provider/model route in `sol-pi.json`, model selection remains with Pi. Action Fusion uses Pi's default shell behavior. Persistent artifacts are derived from Pi's session directory and session ID.

Archived evidence is never deleted automatically: placeholders and receipts in live sessions may still reference it. The `sol-pi` directory under a project's session directory aggregates every session of that project; when it grows past 1,024 archived objects or 256 MiB, the next session start raises one warning (a UI notification, or stderr in print/JSON mode) naming the directory. Reclaim space by removing old session directories by hand.

## Trust

A project-local config can enable file mutation, shell execution, local archival, and remote diagnostic-log reduction. SoL-Pi waits for Pi's `session_start` context and ignores the project file unless `ctx.isProjectTrusted()` is true. Prefer the global file when you want one personal configuration across trusted projects.
