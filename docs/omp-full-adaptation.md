# Oh My Pi 完全适配缺口清单

本文审计 `omp-compat` 分支相对 Oh My Pi（omp）的适配缺口，结论引用格式 `路径:行号`。

> **状态**：审计基线是 omp 18.3.0 与实现前的 `omp-compat`（`SOL/` 行号对应该时点）。
> 审计后本分支已落地 G1–G3、G5–G9 与 G12（修复见 `docs/compatibility.md` 与对应测试），
> G4 按「文档记录 + 建议复验」处理，G10/G11 现场观察无需改动。阅读时把下文 §2 的
> 「缺口」理解为该时点的审计记录，而非当前待办。路径前缀：

| 前缀 | 实际位置 |
| --- | --- |
| `SOL/` | 本仓库（`~/Projects/GitHub/SoL-Pi`） |
| `OMP/` | 本机 omp 18.3.0 包根（`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent`） |
| `PI/` | 仓库内安装的上游 Pi 0.85.1（`SOL/node_modules/@earendil-works/pi-coding-agent`） |
| `OMP-UTILS/` | `~/.bun/install/global/node_modules/@oh-my-pi/pi-utils` |
| `OMP-CORE/` | `~/.bun/install/global/node_modules/@oh-my-pi/pi-agent-core` |
| `OMP-TUI/` | `~/.bun/install/global/node_modules/@oh-my-pi/pi-tui` |
| `OMP-AI/` | `~/.bun/install/global/node_modules/@oh-my-pi/pi-ai` |

审计基线：omp 18.3.0（`OMP/package.json:2`）；`docs/compatibility.md` 记录的验证基线是 18.2.6/18.2.7。

## 结论摘要

- **没有**「扩展完全加载不了」级别的缺口：SoL-Pi 用到的每一个 `@earendil-works/*` specifier 与裸 `typebox` 在 omp 上都能解析，`@earendil-works/pi-ai/compat`、`findCutPoint`、`sessionEntryToContextMessages`、`CONFIG_DIR_NAME` 这些历史上踩过坑的导出 omp 都已补齐（原因见 §1.1）。用 bun 直接 import omp 的四个 shim 逐一验证过运行时导出。
- 但「完全适配」还差 **12 条**，其中 **2 条功能级**：Action Fusion 的 `then_run` 绕过 omp 的审批分级（写级工具内执行 exec 级命令，安全相关）；Evidence-Preserving Reducer 在 omp 上拿不到命令的完整输出，只能对截断预览做证据校验。
- 另有 6 条行为退化、4 条体验/文档。未跟踪文件 `SOL/src/sol-pi/extensions/action-fusion/mutation-preview.ts` 正是体验级缺口 G9 的修复，但它**尚未接线**（`grep -rn previewMutationCall SOL/src` 只命中它自己的函数声明，`action-fusion/index.ts` 未引用）；本次审计未改动它。

「完全适配」的收口条件（逐条详见 §2）：

1. G1 融合工具显式声明 `approval`，让 `then_run` 按 exec 级受 omp 审批约束（**功能/安全**）。
2. G2 EPR 能从 omp 的 `meta.truncation.artifactId` 取回完整输出，取不到时留痕而非静默降级（**功能**）。
3. G3 `context.signal` 缺失的处理显式化（EPR 超时兜底、OCC 改用 stopReason/isIdle 判据）。
4. G4 宿主判定从「有无托管定时器」升级为能力探测，并记录 `agent_settled` 在 omp 不可达。
5. G5 `input` 事件缺 `streamingBehavior` 的判定分支与返回值形状分支。
6. G6 SoL-Pi 自有工具声明 `approval`，收紧审批模式时不误伤。
7. G7 `compactSession` 失败只上报一次。
8. G8 「registry 无 `complete`」在文档里定为 omp 常态，并处理 baseUrl 差异。
9. G9 融合 `edit`/`write` 行接线 `previewMutationCall`，恢复参数派生预览。
10. G10 记录 `renderShell` 在 omp 无效。
11. G11 `agents-install.md` 补 omp 安装/校验步骤，验证基线推到 18.3.0。
12. G12 建立 omp 侧冒烟清单（Pi 侧 vitest 无法覆盖兼容层）。

---

## 1. 现状适配清单

`SOL/src/sol-pi/host-compat.ts` 是一个「按宿主实际传值判断、不按宿主名字判断」的适配层，覆盖 4 个面；另有 8 处适配散在调用点。

### 1.1 加载与解析面（omp 兼容层自身已补齐的部分）

omp 的兼容层分两级：进程级 `Bun.plugin()` 的 onResolve 改写，加上（编译/打包形态下）Babel AST 级源码改写。

- scope/包名表：`CANONICAL_PI_SCOPE = "@oh-my-pi"`（`OMP/src/extensibility/plugins/legacy-pi-compat.ts:800`）、`PI_SCOPE_ALIASES = ["oh-my-pi","mariozechner","earendil-works"]`（`:803`）、`PI_PACKAGE_NAMES = ["pi-agent-core","pi-ai","pi-coding-agent","pi-natives","pi-tui","pi-utils"]`（`:805`）、匹配正则 `LEGACY_PI_SPECIFIER_FILTER`（`:837`）。
- 包根 shim：pi-coding-agent → `legacy-pi-coding-agent-shim.ts`（`:962-964`、override `:1023`）、pi-ai → `legacy-pi-ai-shim.ts`（`:951-953`）、pi-tui → `legacy-pi-tui-shim.ts`（`:969-971`）。
- 子路径重定位 `PI_SUBPATH_REMAPS`（`:816-820`），其中 `["pi-ai/compat", "pi-ai"]`（`:819`）——这正是 SoL-Pi `provider.ts` 里 `@earendil-works/pi-ai/compat` 的入口。
- 裸 `typebox` → omptype TypeBox 外观：`TYPEBOX_SPECIFIER_FILTER = /^(?:@sinclair\/typebox|typebox)$/`（`:873`），解析到 `legacy-typebox.ts`（`:941`）。子模块（`typebox/compiler` 等）故意不改写（`:869-872` 注释）——SoL-Pi 不使用子模块。
- 插件加载时安装：`loader.ts:39 installLegacyPiSpecifierShim();`；Bun.plugin 注册在 `:2686-2712`。
- **运行时逐一验证过**（bun 直接 import shim）：`CONFIG_DIR_NAME`、`Theme`、`buildSessionContext`、`createBashToolDefinition`、`createEditToolDefinition`、`createWriteToolDefinition`、`estimateTokens`、`findCutPoint`、`getAgentDir`、`sessionEntryToContextMessages`、`ModelRegistry`、`SessionManager`、`getProjectDir` 全部存在；`complete` 经 pi-ai 根 shim 可达（`OMP/src/extensibility/legacy-pi-ai-shim.ts:132` `export * from "@oh-my-pi/pi-ai"`，pi-ai 的 `complete` 在 `OMP-AI/src/stream.ts:1135`）；pi-tui 侧 `Container`/`Text` 可达（`legacy-pi-tui-shim.ts` 只额外补 `decodeKittyPrintable`/`getCapabilities`/`deleteKittyImage`）。
- 兼容层里明确为 SoL-Pi 打的补丁：`legacy-pi-coding-agent-shim.ts:1518-1523` 的注释直接点名 `NVlabs/SoL-Pi's online-context-compact`，并解释了 `findCutPoint`/`sessionEntryToContextMessages` 曾因 barrel 缺口过不了 Bun 的静态导出检查（issue #11796）。

### 1.2 `host-compat.ts` 已覆盖的 4 个宿主差异

| # | 差异 | 适配实现 | omp 侧证据 |
| --- | --- | --- | --- |
| 1 | `compact()` 是回调式（Pi）vs 返回 Promise + `internalGuidance` + `suppressContinuation`（omp） | 同时下发 `customInstructions` 与 `internalGuidance`，同时接 `onComplete`/`onError` 与 Promise，先到者生效：`SOL/src/sol-pi/host-compat.ts:199-246` | `OMP/src/extensibility/extensions/types.ts:358-390`（CompactOptions：`onComplete` :359、`onError` :360、`internalGuidance` :378、`suppressContinuation` :389，**没有 `customInstructions` 字段**）；`compact` 签名 `:439`；`compact-handler.ts:14-22` 把 union 拆成 `session.compact(instructions, options)`，所以 SoL-Pi 传的 `customInstructions` 被丢弃、`internalGuidance` 生效；`session-maintenance.ts:1386` `options?.internalGuidance ?? customInstructions`，`:1117`/`:1450` 调 `onComplete` |
| 2 | 内置工具参数 schema 形状（TypeBox `properties` vs 可调用的 omptype schema，只能经 `toJsonSchema()` 取文档） | `withOptionalProperty()` 两条分支：有 `properties` 直接展开，否则从 JSON Schema 文档重建并按 `required` 标可选、保留 `additionalProperties`：`SOL/src/sol-pi/host-compat.ts:99-153`（函数体 `:116`） | `OMP/src/extensibility/tool-proxy.ts`（`parameters` 是活 getter，可调用 schema 原样透传）；`OMP/src/extensibility/extensions/loader.ts:216-224` |
| 3 | 渲染参数顺序：Pi `renderCall(args, theme, context)` / `renderResult(result, options, theme, context)`；omp `renderCall(args, options, theme)` / `renderResult(result, options, theme, args)` | `resolveCallRender`/`resolveResultRender` 按「第二个参数像不像 theme」判断顺序（`SOL/src/sol-pi/host-compat.ts:155-179`）；`invokeBaseRenderer` 原样转发宿主 renderer（`:181-196`） | `OMP/src/extensibility/extensions/wrapper.ts:53-62`（renderCall 透传 `(args, options, theme)`；renderResult 重打包成 `(result, {expanded,isPartial,spinnerFrame}, theme, args)`）；类型 `types.ts:654`、`:657-662`；`ToolRenderResultOptions` `:574-580` |
| 4 | omp 有托管定时器（`setTimeout`/`setInterval`/`clearTimer`），Pi 0.85.1 没有 | `usesManagedTimers()`（`SOL/src/sol-pi/host-compat.ts:300-302`）作为宿主标记，推出 `rendersToolPromptMetadata()`（`:270-272`）、`boundaryTrigger()`（`:288-298`）、`deferOutsideHandler()`（`:315-325`） | `OMP/src/extensibility/extensions/types.ts:491`/`:497`/`:499`；运行时装配 `OMP/src/extensibility/extensions/runner.ts:1240-1242` |

### 1.3 散在调用点的适配

1. `getSystemPrompt()` Pi 返回单串、omp 返回行数组 → `systemPromptText()` 按数组 join（`SOL/src/sol-pi/host-compat.ts:254-262`）。omp 侧 `types.ts:471 getSystemPrompt(): string[]`，装配 `OMP/src/modes/runtime-init.ts:129`。
2. `promptSnippet`/`promptGuidelines` 在 omp 上不渲染 → 把指引并入工具描述（`SOL/src/sol-pi/host-compat.ts:270-272`；`SOL/src/sol-pi/extensions/observation-pack/index.ts:99-105`；`SOL/src/sol-pi/extensions/online-context-compact/tools.ts:76-78`）。omp 侧：`promptSnippet` 全包 0 命中；`promptGuidelines` 只有一处声明 `OMP/src/extensibility/extensions/types.ts:691`（`ToolInfo` 字段，全包无人写入、无人读取）。
3. 无持久会话目录（`--no-session`）时跳过归档而不是让请求失败（`SOL/src/sol-pi/runtime-paths.ts:17-40`）。omp 侧 `SessionManager.inMemory().getSessionDir()` 实测返回 `""`（`OMP/src/session/session-manager.ts:2533-2535`）。
4. 扩展加载期宿主 action 方法会抛错 → `publishedEntries()` 吞掉异常返回 `[]`（`SOL/src/sol-pi/extensions/action-fusion/base-tools.ts:50-64`）。omp 侧 `ExtensionRuntimeNotInitializedError`（`OMP/src/extensibility/extensions/loader.ts:90-94`）与 `getAllTools` 存根 `:133`，以及 `registerTool` 按名覆盖 `:216-224`、`ToolInfo.sourceInfo.source === "builtin"`（`types.ts:687-693`、`:716-725`）——SoL-Pi 读的都是 omp 真实提供的字段，`sourceInfo` 有 `builtin` 值。
5. `PI_EDIT_VARIANT` 在 omp 上被真实读取（`SOL/src/sol-pi/extensions/action-fusion/base-tools.ts:203-215`；omp 侧 `OMP/src/utils/edit-mode.ts:38`、`OMP/src/edit/index.ts:363`）。
6. 宿主重注册内置工具时绑定的 `ctx.invokeTool` 委派（`SOL/src/sol-pi/extensions/action-fusion/index.ts:126-140`）。omp 侧 `OMP/src/extensibility/extensions/types.ts:503-514`（同义工具委派，深度 8 上限）、`runner.ts:571-600`、`wrapper.ts:74-84`。
7. 配置/数据路径全部经宿主 API：`CONFIG_DIR_NAME` + `getAgentDir()`（`SOL/src/sol-pi/config.ts:48-58`、`SOL/src/sol-pi/index.ts:41`）。omp 侧实测 `CONFIG_DIR_NAME === ".omp"`（`OMP-UTILS/src/dirs.ts:24`）、`getAgentDir() === ~/.omp/agent`（`OMP-UTILS/src/dirs.ts:581-583`）——所以 omp 上项目配置是 `<cwd>/.omp/sol-pi.json`、用户级是 `~/.omp/agent/sol-pi.json`，与 `README.md:95-101`、`SOL/docs/configuration.md:11` 的记录一致。
   注意副作用：omp 的 `isProjectTrusted()` 硬编码返回 `true`（`OMP/src/extensibility/extensions/types.ts:459-469`、`runner.ts:1201`），于是 SoL-Pi 在 omp 上**永远**会读项目级 `sol-pi.json`；这与 omp 自己「项目输入无条件加载」的模型一致，不是缺口，但`agents-install.md` 里「项目级注册只应在受信项目里进行」的约束在 omp 上不成立，值得写进文档。
8. 会话 id/目录来自 `sessionManager`：omp 的 id 是 UUIDv7（`OMP/src/session/session-manager.ts:115-117`），满足 SoL-Pi 的 `SESSION_ID_PATTERN`（`SOL/src/sol-pi/runtime-paths.ts:9`）；`appendEntry` 写出的条目形状 `{type:"custom", customType, data}` 与 OCC 的 `restoreOnlineState` 期望完全一致（`OMP/src/session/session-manager.ts:2946-2950` vs `SOL/src/sol-pi/extensions/online-context-compact/state.ts:133-141`）。

### 1.4 事件面（除 `agent_settled` 外全部对齐）

SoL-Pi 用到 12 个事件：`session_start`、`before_agent_start`、`context`、`before_provider_request`、`tool_result`、`turn_end`、`agent_settled`、`session_before_tree`、`session_tree`、`session_compact`、`session_shutdown`、`input`。

- 双方事件重载列表做集合差：**Pi 有而 omp 没有**的是 `agent_settled`、`before_provider_headers`、`model_select`、`project_trust`、`session_before_fork`、`session_compact_failed`、`session_info_changed`、`thinking_level_select`、`ui_prompt_start`、`ui_prompt_end`；SoL-Pi 只用其中的 `agent_settled`（见 G4）。omp 侧列表在 `OMP/src/extensibility/extensions/types.ts:1240-1300`。
- 事件负载形状逐条核对通过：`TurnEndEvent.message`/`toolResults`（`OMP/src/extensibility/shared-events.ts:213-217`，SoL-Pi 读 `event.toolResults[].toolCallId`/`isError`、`event.message.stopReason`）；`SessionCompactEvent.fromExtension`（`shared-events.ts:89`）；`SessionBeforeTreeResult.cancel`（`shared-events.ts:409-411`）；`ContextEventResult.messages`（`types.ts:1122-1124`，ObservationPack 的替换路径）；`ToolResultEvent.input/content/details/isError/toolName`（`types.ts:992-1035`，其中 `input` 为 `:995`）；`BeforeProviderRequestEventResult = unknown`（`types.ts:1126`）；`InputEvent.text`（`types.ts:913-918`，缺 `streamingBehavior` 的差异见 G5）。
- 注册未知事件名不会报错：`on<F extends HandlerFn>(event: string, handler: F)`（`OMP/src/extensibility/extensions/loader.ts:210-214`）——这正是 `agent_settled` 在 omp 上静默失效而不是加载失败的原因。

---

## 2. 遗留缺口清单

排序：功能错误 → 行为退化 → 体验/文档。

### 2.1 功能错误

#### G1（功能/安全）Action Fusion 的 `then_run` 绕过 omp 的审批分级

**现象**：omp 有工具审批分级（read < write < exec，`OMP/src/tools/approval.ts:100-104`）。融合后的 `edit`/`write` 继承内置 edit 的 `approval` 函数，因此按 **write 级**放行；但同一次调用里的 `then_run` 是直接用合成会话 `new BashTool(session)` 跑的，不经过任何审批解析。后果：把 `tools.approvalMode` 设成 `write`（或 `always-ask`）时，模型可以把任意 shell 命令塞进 `then_run`，在本应只需 write 级审批的 edit 调用里执行 exec 级命令——omp 对原生 `bash` 的 exec 级门禁被绕过。上游 Pi 没有分级概念，所以这只在 omp 上是缺陷。

**omp 侧证据**：

- `OMP/src/extensibility/legacy-pi-coding-agent-shim.ts:720-729`：`createEditToolDefinition` 直接 `return legacyBuiltinTool(cwd, "edit")`（`createWriteToolDefinition` 同理 `:737-746`）。
- `OMP/src/extensibility/legacy-pi-coding-agent-shim.ts:270-285`：`legacyBuiltinTool` 里 `approval: tool.approval` 照抄内置工具，`:245-246` `createRegistryTool("edit") = new EditTool(session)`。
- `OMP/src/edit/index.ts:414-418`：`EditTool.approval` 返回 `"read" | "write"`（按目标路径判定），所以融合工具的 tier 是 write。
- `OMP/src/extensibility/legacy-pi-coding-agent-shim.ts:518`：bash 工具 `approval: "exec"`；`:243-244`：`createRegistryTool("bash") = new BashTool(session)`；`:226-234`：合成 `ToolSession`（`hasUI:false`、`getSessionFile:()=>null`、`Settings.isolated(...)`）。
- `OMP/src/extensibility/extensions/wrapper.ts:178-195` 与 `:340-350`：审批只在**外层被调用工具**上解析一次，内层直接 `tool.execute(...)` 不再过门禁。
- `OMP/src/tools/approval.ts:153-177`：`resolveToolTier`/`getToolDecision` 只在工具自报 tier 时生效；`:186-190`、`:297-302`：未声明 `approval` 默认 exec 级、模式不允许时落到 `policy: "prompt"`。
- 委派也无解：`ctx.invokeTool` 只能委派**同名**内置工具（`OMP/src/extensibility/extensions/types.ts:503-514`「Delegation is same-tool only」），所以不能借它把 `then_run` 交给原生 bash。

**SoL-Pi 侧现状**：`SOL/src/sol-pi/extensions/action-fusion/then-run.ts:179-180`：

```ts
const bash = createBashToolDefinition(ctx.cwd, bashOptions);
const bashResult = await bash.execute(`${toolCallId}:then_run`, thenRun, signal, undefined, ctx);
```

**建议改法**：给融合定义显式声明 `approval`（omp 的 `ToolDefinition.approval` 支持函数式，`OMP/src/extensibility/extensions/types.ts:625-627`；判定走 `OMP/src/tools/approval.ts:153-166`）：入参带 `then_run` 时返回 `"exec"`，否则沿用内置 edit/write 的分级函数。该字段必须经 `host-compat.ts` 注入（Pi 的 `ToolDefinition` 没有 `approval`，直接加会触发 TS 多余属性检查，需 cast；Pi 侧运行时忽略未知字段）。若不想引入分级语义，退化方案是在审批模式非 `yolo` 时拒绝 `then_run` 并在结果里说明原因。

**涉及文件**：`src/sol-pi/extensions/action-fusion/index.ts`、`src/sol-pi/extensions/action-fusion/then-run.ts`、`src/sol-pi/host-compat.ts`、`docs/compatibility.md`。

#### G2（功能）Evidence-Preserving Reducer 在 omp 上取不到命令的完整输出

**现象**：EPR 的契约是「对命令产出的**确切字节**做证据校验，而不是对预览」，实现方式是当内联结果被截断时去读宿主落盘的完整输出文件。Pi 把完整输出写到 `pi-bash-*.log` 并把路径放在 `details.fullOutputPath`；omp 把它写成 **artifact**，只在 `details.meta.truncation.artifactId` 里给一个 id，正文提示是 `Read artifact://N for full output`。于是 omp 上 `detailsFullOutputPath()` 返回 `undefined`，内联正则也匹配不到，代码静默回退到**被截断的内联预览**——归档、`minBytes` 判定、引文校验全部只针对预览，截断点以下的关键证据不会进入 receipt。

**omp 侧证据**：

- `OMP-TUI/src/tools/output-meta.ts:9-30`：`TruncationMeta`，其中 `:26-27` `/** Artifact ID if full output was saved */ artifactId?: string`。
- `OMP-TUI/src/tools/output-meta.ts:131-133`：`formatFullOutputReference(id) => \`Read artifact://${id} for full output\``。
- `OMP-TUI/src/tools/output-meta.ts:199-206`：截断提示拼装（`direction: "middle"/"head"/"tail"` + artifact 引用），由 `formatOutputNotice`（`:281-292`）汇总。
- `OMP/src/tools/bash.ts:770`：`return text + formatOutputNotice(result.details?.meta);` —— 截断提示就是这样接在结果文本后面的；`:696-703` 与 `:295-297`（`saveBashOriginalArtifact`）把被截断的完整输出落成 artifact；`:799`、`:1407` 经 `allocateOutputArtifact("bash")` 分配 id。
- `OMP-TUI/src/tools/bash.ts:32-40`：`BashToolDetails = { meta?: OutputMeta; timeoutSeconds?; ... }`——**没有 `fullOutputPath`**；全包 `grep -rn fullOutputPath` 只命中无关的 `autoresearch` 工具（`OMP/src/autoresearch/tools/run-experiment.ts:49`）。
- 可取回正文的宿主 API：`OMP/src/session/session-manager.ts:2573-2575`（`allocateArtifactPath`）、`:2588-2590`（`getArtifactPath(id)`）。运行期 `ctx.sessionManager` 就是完整 `SessionManager` 实例（`OMP/src/extensibility/extensions/runner.ts:1199`），所以 `getArtifactPath` 可用（只是不在 Pi 的 `ReadonlySessionManager` 类型里，需要 cast）。

**SoL-Pi 侧现状**：`SOL/src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts:29-35`（只认 `details.fullOutputPath`，且只接受 `basename` 匹配 `/^pi-bash-[^/\\]+\.log$/` 的 tmp 路径）、`:48-56`（否则回退内联）、`:71`/`:91`（bash 与融合 edit/write 两条路径都走它）。

**建议改法**：在 `exactBodyFromInline` 前加 omp 分支：识别 `event.details?.meta?.truncation?.artifactId`，用 `(ctx.sessionManager as {getArtifactPath?(id:string):Promise<string|null>}).getArtifactPath(id)` 取路径并读文件（注意 `artifact://` 文案里的 id 与 `getArtifactPath` 的 id 同源，`OMP/src/session/session-manager.ts:2573-2575`/`:2588-2590`）；读不到时**记一条 journal fallback**（例如 `reason: "full-output-unavailable"`）而不是无声降级，这样「只对预览做了证据校验」这件事在会话记录里可见。`candidate.ts` 目前只接 `event`，需要把 `context` 或 `sessionManager` 传进来。

**涉及文件**：`src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts`、`src/sol-pi/extensions/evidence-preserving-reducer/index.ts`、`docs/compatibility.md`。

### 2.2 行为退化

#### G3 `ExtensionContext` 在 omp 上没有 `signal`

- **现象**：上游 Pi 的 `ExtensionContext.signal` 是「当前中断信号，非流式运行时为 undefined」（`PI/dist/core/extensions/types.d.ts:236`）。omp 的 `ExtensionContext` **没有这个成员**（`OMP/src/extensibility/extensions/types.ts:429-530` 的完整成员表；运行期装配 `OMP/src/extensibility/extensions/runner.ts:1187-1245` 同样没有）。SoL-Pi 的两处读取因此恒为 `undefined`。
- **影响 1**：reducer 请求不再随宿主的 abort 一起取消，只剩自己的超时兜底 —— `SOL/src/sol-pi/extensions/evidence-preserving-reducer/provider.ts:117` `operationSignal(context.signal, config.timeoutMs)`（`operationSignal` 见 `:74-92`：只有 `parent` 才会 relay abort）。
- **影响 2**：OCC 的 `turn_end` 守卫里 `context.signal?.aborted` 恒为假（`SOL/src/sol-pi/extensions/online-context-compact/extension.ts:374`），即「回合已被中断就不作为压缩边界」。stopReason 检查（`:375-377`）仍然生效，所以只在「stopReason 未标记 aborted 但宿主已发中断」的窗口里与 Pi 行为不同。
- **建议改法**：在 `host-compat.ts` 加 `hostAbortSignal(context)`，返回 `(context as {signal?: AbortSignal}).signal`；omp 上返回 `undefined` 时，EPR 保持超时-only（现状），并在 `docs/compatibility.md` 明写；OCC 侧不要再依赖该信号，改为以 `event.message.stopReason`/`context.isIdle()` 为判据（`isIdle` 双方都有，`OMP/src/extensibility/extensions/types.ts:456`）。若希望 EPR 真正可取消，可改用 `ctx.setTimeout` 驱动的显式超时 + 检查 `ctx.isIdle()`。
- **涉及文件**：`src/sol-pi/host-compat.ts`、`src/sol-pi/extensions/evidence-preserving-reducer/provider.ts`、`src/sol-pi/extensions/online-context-compact/extension.ts`。

#### G4 `agent_settled` 在 omp 上永不触发（settle 路径不可达）

- **现象**：OCC 注册了 `agent_settled`（`SOL/src/sol-pi/extensions/online-context-compact/extension.ts:428`），但 omp 全包 `grep -rn agent_settled` 0 命中：既没有事件类型（Pi 侧是 `PI/dist/core/extensions/types.d.ts:561`、重载 `:926`），也没有任何 emit 点。注册不会报错（`OMP/src/extensibility/extensions/loader.ts:210-214` 不校验事件名），只是永远不触发。
- **当前是否造成功能损失**：**否**。omp 上 `boundaryTrigger()` 经 `usesManagedTimers()` 判为 `deferred`（tui/rpc）或 `unavailable`（json/print）（`SOL/src/sol-pi/host-compat.ts:288-302`、`docs/compatibility.md:135-139`），settle 分支从未被选中。所以这是「死代码 + 未验证假设」而不是当前故障。
- **风险**：整个宿主判定建立在一个间接信号上——「有托管定时器 ⇒ 是 omp」。同一函数还决定 `rendersToolPromptMetadata()`（`host-compat.ts:270-272`）。如果未来 Pi 引入托管定时器、或 omp 调整它，两个判定会同时错向，且失败是静默的（边界压缩停摆 / 指引丢失）。omp 侧确实存在可用作 settle 信号的事件（`agent_end` `OMP/src/extensibility/shared-events.ts:194-200`、`session_stop` `:98-102`）。
- **建议改法**：把宿主判定从「有无托管定时器」改成显式能力探测组合（`mode` 取值 + `setTimeout` + `invokeTool` + `getSystemPrompt()` 返回类型），并在 `agent_settled` 之外补一个 `agent_end`/`session_stop` 的兜底 handler；同时在 `docs/compatibility.md` 记录「omp 无 `agent_settled`，settle 路径在 omp 上不可达」。
- **涉及文件**：`src/sol-pi/host-compat.ts`、`src/sol-pi/extensions/online-context-compact/extension.ts`、`docs/compatibility.md`。

#### G5 `input` 事件：omp 缺 `streamingBehavior`，`InputEventResult` 形状也不同

- **现象**：Pi 的 `InputEvent` 带 `streamingBehavior?: "steer" | "followUp"`（`PI/dist/core/extensions/types.d.ts:666`），omp 的 `InputEvent` 只有 `{text, images?, source}`（`OMP/src/extensibility/extensions/types.ts:913-918`）。SoL-Pi 用它区分「流式期间的 steer」与「CORRECTION: 纠正」（`SOL/src/sol-pi/extensions/online-context-compact/extension.ts:253-259`）。omp 上 `event.streamingBehavior` 恒为 `undefined`，于是 `!== "steer"` 恒真，只靠 `text.startsWith("CORRECTION:")` 判定 —— 一个 `CORRECTION:` 前缀的 steer 输入在 omp 上会被记成纠正，在 Pi 上不会。
- **附带**：返回值形状也不同。Pi 是 `{action:"continue"} | {action:"transform",...}`，omp 是 `{handled?, text?, images?}`（`types.ts:1130-1137`，消费逻辑 `OMP/src/extensibility/extensions/runner.ts:1663-1676`）。SoL-Pi 返回的 `{action:"continue"}` 在 omp 上被当作「无字段」处理，等价于不干预，因此**行为上等价、字段无意义**，但读代码的人会误解。
- **建议改法**：在 host-compat 里加 `inputCorrectionState(event)` 之类的判定封装：omp 分支不看 `streamingBehavior`，改用 `source === "extension"` 排除非用户输入并把「文本前缀匹配」作为唯一判据，或直接按文本前缀判定并在文档里注明 omp 缺字段；返回值按宿主形状分支（omp 返回 `undefined`）。
- **涉及文件**：`src/sol-pi/extensions/online-context-compact/extension.ts`、`src/sol-pi/host-compat.ts`、`docs/compatibility.md`。

#### G6 SoL-Pi 自己的工具在 omp 上是 exec 级

- **现象**：`obs_recall` 与 `update_plan` 都没有声明 `approval`，omp 对未声明的工具默认按 **exec 级**处理（`OMP/src/tools/approval.ts:177`「defaulting to tier "exec" when omitted」，tier 表 `:100-110`，越级落到 `policy: "prompt"` `:297-302`）。默认 `tools.approvalMode` 是 `yolo`（`OMP/src/tools/approval.ts:72`、`:82`），此时一切照常；但用户把模式收紧为 `write`/`always-ask` 后，连只读的 `obs_recall` 也会被要求审批，而 Pi 上完全不存在这个概念。
- **建议改法**：注册时显式声明 `approval: "read"`（`obs_recall`）与 `approval: "read"`/`"write"`（`update_plan`，只写会话自定义条目，read 级也合理）；同样需经 host-compat 注入以避免 Pi 类型报错。
- **涉及文件**：`src/sol-pi/extensions/observation-pack/index.ts`、`src/sol-pi/extensions/online-context-compact/tools.ts`、`src/sol-pi/host-compat.ts`。

#### G7 `compactSession` 在 omp 上会把一次压缩失败上报两次

- **现象**：omp 的失败路径是先调 `options.onError(err)` 再 `throw`（`OMP/src/session/session-maintenance.ts:1476-1477`），异常经 `runExtensionCompact`（`OMP/src/extensibility/extensions/compact-handler.ts:14-22`）冒泡成 `ctx.compact()` 的 rejection；而 `compactSession` 的 `failure()` 没有 `finished` 守卫，catch 里会**再**调一次 `options.onError`（`SOL/src/sol-pi/host-compat.ts:210-213` 定义；调用点 `:233` 与 `:244`）。
- **影响**：目前唯一调用点（OCC `compactBoundary`，`SOL/src/sol-pi/extensions/online-context-compact/extension.ts:322-345`）只是把 error 存进变量，重复赋值无害。属潜在缺陷：任何未来的 `onError` 实现（计数、上报、状态机）都会被打乱。
- **建议改法**：把 `options.onError(...)` 放进 `finished` 守卫，例如 `const failure = (e) => { if (finished) return; options.onError(...); finish(); }`。
- **涉及文件**：`src/sol-pi/host-compat.ts`。

#### G8 EPR 在 omp 上只能走「旧版认证 + pi-ai 直调」路径

- **现象**：`CompatibleModelRegistry.complete` 在 omp 上不存在 —— `ModelRegistry` 整个类没有 `complete`（`OMP/src/config/model-registry.ts:239` 起的类，运行期 `Object.getOwnPropertyNames(ModelRegistry.prototype).includes("complete") === false`；补全 API 是自由函数 `OMP-AI/src/stream.ts:1135-1141`）。所以 `SOL/src/sol-pi/extensions/evidence-preserving-reducer/provider.ts:137-146` 每次都走 `else` 分支：`registry.getApiKeyAndHeaders(model)` + `completeCompat(...)`。这条路径 omp 是官方支持的（`OMP/src/config/model-registry.ts:2798-2810` 的注释就叫「Resolve request authentication through the historical Pi extension facade」，返回 `{ok:true, apiKey, headers}`，`ResolvedRequestAuth` 在 `:226-235`）。
- **代价**：omp 的 `ResolvedRequestAuth` **没有 `baseUrl`**（Pi 有），所以 `SOL/.../provider.ts:142` 的 `const legacyModel = auth.baseUrl ? {...model, baseUrl} : model` 在 omp 上恒走 else，按凭据解析出的 base URL 不会被采用（omp 把 base URL 归到 `getProviderBaseUrl`/model 上）。`env` 也不会被消费——omp 的 `StreamOptions` 没有 `env` 字段（`OMP-AI/src/types.ts:406` 起，有 `apiKey` `:427` 与 `headers` `:459`，无 `env`、无 `timeoutMs`），而 `timeoutMs` 的缺失由 SoL-Pi 自己的 `operationSignal` 超时兜住了（`SOL/.../provider.ts:85-88`）。
- **建议改法**：把「registry 无 `complete`」这条分支在文档里点明为 omp 的**常态**而不是降级；如遇 base URL 相关的认证失败，改为优先使用 `ctx.models.resolve(...)`（omp 新的只读模型查询面，`OMP/src/extensibility/extensions/types.ts:406-424`）拿到已带 base URL 的 `Model`，或补一次 `getProviderBaseUrl(provider)`。
- **涉及文件**：`src/sol-pi/extensions/evidence-preserving-reducer/provider.ts`、`docs/compatibility.md`。

### 2.3 体验 / 文档

#### G9 融合 `edit`/`write` 的行在 omp 上丢失内置渲染（`mutation-preview.ts` 尚未接线）

- **现象**：omp 的内置工具行渲染是一张按工具名索引的表（`OMP-TUI/src/tools/index.ts:35 export const toolRenderers: Record<string, ToolRenderer>`；取用处 `OMP-TUI/src/chat/tool-execution.ts:355`）。一旦扩展重注册了同名工具，omp 会清掉该名字的内置来源标记（`OMP/src/sdk.ts:4101-4103` `builtInRegistryToolNames.delete(name); session.setToolBuiltIn(name, false);`，`hasBuiltInTool` 见 `OMP/src/session/session-tools.ts:561-568`），渲染侧随即改用「扩展自带 renderer」路径（`OMP/src/modes/controllers/event-controller.ts:1640`、`:1674` `useBuiltInRenderer: this.ctx.viewSession.hasBuiltInTool(renderToolName)`）。而 Action Fusion 复用的基础定义**没有 renderer**：`createEditToolDefinition`/`createWriteToolDefinition` 走 `legacyBuiltinTool`（`OMP/src/extensibility/legacy-pi-coding-agent-shim.ts:720-729`、`:737-746`、`:270-285`），只带 `name/label/description/parameters/hidden/deferrable/approval/execute`。于是 `invokeBaseRenderer()` 在 omp 上恒返回 `undefined`（`SOL/src/sol-pi/host-compat.ts:181-196`），融合行退化成一行 `edit <path>` 纯文本（`SOL/src/sol-pi/extensions/action-fusion/index.ts:88-100`、`:216-278`），丢掉了内置 edit 行的 diff 预览。
  （对照：omp 的 shim 对 `read`/`bash`/`grep`/`find`/`ls` 都造了带 `renderCall`/`renderResult` 的定义——`legacy-pi-coding-agent-shim.ts:462`、`:494`、`:561`、`:619`、`:675`——只有 edit/write 没有。）
- **与未跟踪文件的关系**：`SOL/src/sol-pi/extensions/action-fusion/mutation-preview.ts`（未跟踪）导出的 `previewMutationCall()`（`:145`）就是针对这个场景的参数派生预览；`grep -rn previewMutationCall SOL` 只命中它自己的声明，`action-fusion/index.ts` 未引用，**当前是未接线的半成品**。它的渲染只用 `accent/dim/error/success` 四个主题色键，omp 的主题键表包含这四个（`OMP-TUI/src/theme/schema.ts:26-46`），所以接线没有额外的主题风险。
- **建议改法**：在 `renderFusedMutation` 的 `base === undefined` 分支改为调用 `previewMutationCall(view.theme, name, view.args)`（而不是 `renderThemedLine(theme,"dim",...)`），即把「宿主没有内置 renderer」当作正常分支而不是退化分支；`renderShell: "self"` 的语义差异见 G10。另外注意 omp 传给 `renderResult` 的第 4 个参数是**工具实参本身**（`OMP/src/extensibility/extensions/wrapper.ts:57-62`），`resolveResultRender` 已按此处理（`SOL/src/sol-pi/host-compat.ts:167-175`）。
- **涉及文件**：`src/sol-pi/extensions/action-fusion/index.ts`（引用 `mutation-preview.ts`）、`docs/compatibility.md`。

#### G10 `renderShell: "self"` 在 omp 上无效

- **现象**：SoL-Pi 在 `obs_recall`（`SOL/src/sol-pi/extensions/observation-pack/index.ts:105`）与 `update_plan`（`SOL/src/sol-pi/extensions/online-context-compact/tools.ts:78`）上声明了 `renderShell: "self"`。该字段属于 Pi 的 `ToolDefinition`（`PI/dist/core/extensions/types.d.ts:360`，语义「由工具自己画外框」，消费点 `PI/dist/modes/interactive/components/tool-execution.js:69 getRenderShell()`）。omp 的 `ToolDefinition` 没有这个字段（`OMP/src/extensibility/extensions/types.ts:604-663`，全包 `grep -rn renderShell` 0 命中），声明被忽略，omp 始终画自己的行外壳。
- **影响**：纯观感——SoL-Pi 自己的「⚡ SoL-Pi · <机制>」标题行会与 omp 的工具行外壳叠加。
- **建议改法**：不必为 omp 改动渲染内容；在 `docs/compatibility.md` 记一条「`renderShell` 在 omp 上无对应字段」，避免后续误以为它是生效的布局开关。
- **涉及文件**：`docs/compatibility.md`。

#### G11 `agents-install.md` 没有 omp 路径，验证基线未更新到 18.3.0

- **现象**：`agents-install.md` 被声明为「single source of truth」，但全文只有 Pi 的安装/校验流程（`pi install`/`pi list`/`pi --version`、`~/.pi/agent`）。omp 的安装方式只在 `README.md:95-101`（`omp plugin install github:yuhaoxin/SoL-Pi#omp-compat`）与 `docs/compatibility.md:67-172` 里，安装器语义没有写进规范文件。另外 `docs/compatibility.md:148`/`:163` 的验证基线是 18.2.6/18.2.7，当前环境是 18.3.0。
- **omp 侧事实（供文档引用）**：`omp plugin install <spec>` 走 `bun install <spec>`，cwd 是 `~/.omp/plugins`（`OMP/src/extensibility/plugins/manager.ts:523-545`、`OMP-UTILS/src/dirs.ts:619-625`），插件清单读自身 package.json 的 `omp`（或历史 `pi`）字段的 `extensions[]`（`OMP/src/extensibility/plugins/types.ts:25-51`、`loader.ts:181-190`），扩展本体经 `loadLegacyPiModule` 载入并走 §1.1 的 specifier 改写。omp **不裁剪也不改写 peerDependencies**（`manager.ts:523-530` 的 argv 里没有任何 peer 相关开关），所以 bun 可能把真实的 `@earendil-works/*` 装进 `~/.omp/plugins/node_modules`，但运行时会被 onResolve 改写到 `@oh-my-pi/*`，只在解析全部失败时才回退到那份真实副本（`legacy-pi-compat.ts:2655-2675`）。同一个事实也说明：`SOL/scripts/check-pi-compat.mjs` 在 omp 语境下校验的是**真实 Pi 副本**而不是 omp 兼容面。
- **建议改法**：把 omp 的安装/校验步骤补进 `agents-install.md`（或在该文件里显式委托到 `docs/compatibility.md` 的 omp 段），并把「验证基线」更新为 18.3.0（或写清 18.2.6/18.2.7 已验、18.3.0 待验）。
- **涉及文件**：`agents-install.md`、`docs/compatibility.md`、`README.md`、`tests/install-guide.test.ts`。

#### G12 测试面：没有任何测试覆盖 omp 路径

- **现象**：全部 22 个测试文件都通过 vite/vitest 直接加载 `SOL/node_modules/@earendil-works/*`（真实 Pi 0.85.1），例如 `tests/pi-package-integration.test.ts:9-16` 用 `createAgentSession`/`DefaultResourceLoader`/`SettingsManager`/`SessionManager`，`tests/online-context-compact-agent-session.test.ts:7-22` 同。**没有**任何测试运行在 omp 兼容层之下，因此 §2 的每一条都只能靠手工会话验证。
- **omp 上没有对应物的地方**：两个集成测试依赖 `@earendil-works/pi-ai/providers/faux`（`tests/pi-package-integration.test.ts:15`、`tests/online-context-compact-agent-session.test.ts:15`）。omp 的 pi-ai 有 `src/providers/mock.ts`（导出 `MOCK_API`/`MockModel`/`createMockModel`/`registerMockApi`/`streamMock`）但**没有** `providers/faux`；`@oh-my-pi/pi-ai` 的 package.json exports 也没有 `./compat` 子路径（该 specifier 由 `PI_SUBPATH_REMAPS` 重定位到包根）。所以把这两个测试移植到 omp 上必须换掉 faux provider，或自己实现一个。
- **关于 `npm run check`（静态判断）**：`package.json` 的 `check = tsc --noEmit && vitest run && npm pack --dry-run`。它只依赖仓库内 `node_modules` 的**真实 Pi 0.85.1**（devDependencies 固定版本，peerDependencies 为 `*`），加上 `npm pack` 与本地 `vitest`，因此在一个完整 checkout 里可跑通，与 omp 是否安装无关；反过来也**不能**证明 omp 行为正确。`tests/package.test.ts` 的 `npm pack --dry-run --json` 是子进程调用，不受宿主影响。
- **建议改法**：新增一个可选的 omp 冒烟脚本（或文档化的手工清单），在 omp 真实进程里至少覆盖：扩展加载无错、`edit`/`write`/`obs_recall`/`update_plan` 四个工具注册、一次融合写+`then_run`、一次 `obs_recall` 分页、一次边界压缩（RPC）。测试文件层面不要试图在 vitest 里伪造 omp（兼容层是 Bun 级插件，Node 下复现不了）。
- **涉及文件**：`tests/`、`agents-install.md`（验证清单）、可能新增 `scripts/` 下的 omp 冒烟脚本。

---

## 3. 18.2.7 → 18.3.0 版本漂移检查

结论：**这段窗口内没有任何改动触及 SoL-Pi 用到的 API 面**。逐包核对（changelog 段落行号）：

| 包（changelog 文件） | 版本 | 段落 | 是否触及 SoL-Pi 的 API 面 |
| --- | --- | --- | --- |
| pi-coding-agent（`OMP/CHANGELOG.md`） | 18.3.0 | `:5` | 只新增 `ctx.runEphemeralTurn()`（`:17`，SoL-Pi 不用）。`hub` 工具弃用（`:9`）、`irc.timeoutMs` 移除（`:10`）、edit-mode 头部（`:11`）、`write` 取消（`:12`）都与 SoL-Pi 无关；`:33` 的「compaction 支持 Anthropic 快照分支」不改变 `ExtensionContext.compact()` 签名 |
| pi-coding-agent | 18.2.11 | `:51` | 全部 Fixed，无关 |
| pi-coding-agent | 18.2.10 | `:63` | `/record`、`omp play`、benchmark，无关 |
| pi-coding-agent | 18.2.9 | `:80` | 恢复 `pi.pi.askToolRenderer`（`:109`/`:132`）、npm 插件清单修复（`:110`/`:136`）、`ttsr_triggered` 每流式违规发一次（`:137`）。都不在 SoL-Pi 的使用面上（SoL-Pi 不影子 ask 工具、不用 ttsr） |
| pi-coding-agent | 18.2.8 | `:152` | 无关 |
| pi-coding-agent | 18.2.7 | `:173` | `bash` 工具移除 `env` 参数（`:178`）——**不影响** SoL-Pi：Action Fusion 传给 bash 的入参只有 `{command, timeout}`（`SOL/src/sol-pi/extensions/action-fusion/then-run.ts:17-20`、`:179-180`）。`Eval judge`/`JudgmentHandle` 变更（`:179`）与 SoL-Pi 无关 |
| pi-agent-core（`OMP-CORE/CHANGELOG.md`） | 18.3.0 | `:5` | 新增 `AgentTool.docTopics`（`:9`）、`TOOL_INTERRUPT_ABORT_REASON`（`:10`），SoL-Pi 不用 |
| pi-agent-core | 18.2.9 | `:23` | `:27` 修流结束时的 message 生命周期事件——SoL-Pi 不订阅 `message_*` |
| pi-ai（`OMP-AI/CHANGELOG.md`） | 18.3.0 | `:5` | `:13` 保留已弃用的 `getApiKey`/`reload`，向后兼容方向，无破坏 |
| pi-ai | 18.2.7 | `:70` | `:74` Anthropic 流式/请求 helper 必须从 `@oh-my-pi/pi-ai/providers/anthropic` 导入；`:75` `NO_AUTH_SENTINEL` 从 `providers/openai-shared` 移到 `auth-retry`。SoL-Pi **没有**导入这两者（只用 `@earendil-works/pi-ai` 的类型与 `compat` 的 `complete`），无影响 |
| pi-tui（`OMP-TUI/CHANGELOG.md`） | 18.3.0 / 18.2.11 | `:5` / `:25` | 无关 |
| pi-tui | 18.2.10 | `:37` | `:41` 多路 TUI paint 监听，SoL-Pi 不用 |
| pi-tui | 18.2.9 | `:44` | `:50` 新增 `stripTerminalSequences` 导出（SoL-Pi 不用） |
| pi-tui | 18.2.7 | `:65` | `:69` 移除专用关键字模块、`:78` 新增 `setMagicKeywords`（SoL-Pi 不用） |

关于本次审计发现的两处 omp 侧行为，**无法用 changelog 归因到窗口内**（即它们不是 18.3.0 引入的回归，而是兼容层一直存在的设计差异）：

- 审批分级与 `then_run` 的交互（G1）：`OMP/src/extensibility/legacy-pi-coding-agent-shim.ts:270-285` 与 `OMP/src/edit/index.ts:414-418` 在窗口内没有对应 changelog 条目。
- 截断输出走 artifact（G2）：`OMP-TUI/src/tools/output-meta.ts:26-27` 的 `artifactId` 与 `formatFullOutputReference`（`:131-133`）同理。

因此 `docs/compatibility.md` 把验证基线标为 18.2.6/18.2.7 是可接受的，但**结论应推广到 18.3.0**（见 §4 的复验建议）。

---

## 4. 验证建议

逐条对应的实测方式（均不需要真实模型额度；除注明外都用 `omp` 的真实会话，不用 vitest）：

| 缺口 | 复验方式 | 期望信号 |
| --- | --- | --- |
| G1 | 把 `tools.approvalMode` 设为 `write`，在一个 omp 会话里让模型调用带 `then_run` 的 `write`（或直接检查 `omp` 的审批提示文本/日志）；再对同一个命令用原生 `bash` 调用作对照 | 原生 `bash` 触发 exec 级审批；修复后融合调用的 `then_run` 也应触发同样的 exec 级审批（当前只按 write 级放行） |
| G2 | 让一个诊断命令产生超过 omp 内联上限的输出（提示会带 `Read artifact://N for full output`），触发 reducer，然后检查 `<sessionDir>/sol-pi/<sessionId>/` 下归档的源文件字节数与 `journal` 里 `candidate` 事件的 `sourceBytes` | 修复前 `sourceBytes` 只等于截断预览大小；修复后等于完整输出大小，且 `journal` 里不再出现无声降级 |
| G3 | 在 RPC 会话里发起一个会触发 reducer 的长日志回合，中途中断 | 修复前 reducer 请求要到 `config.timeoutMs` 才结束；另可在 `turn_end` 打断点确认 `context.signal === undefined` |
| G4 | 在 RPC 会话里把 `agent_settled` handler 打日志，跑一个普通回合 | omp 下该 handler 永不打印（确认不可达）；同时确认 deferred 路径的边界压缩仍按 `docs/compatibility.md:135-139` 工作 |
| G5 | 在 TUI 会话流式输出期间提交 `CORRECTION: ...`，然后看会话文件里 `sol-pi-online-context-state-v1` 自定义条目 | omp 上会被记成纠正（`epoch` +1、`plan` 被清空，`SOL/src/sol-pi/extensions/online-context-compact/state.ts:194-206`）；在 Pi 0.85.1 上同一输入不递增（可临时把该扩展跑在 Pi 上对照） |
| G6 | 把 `tools.approvalMode` 设为 `always-ask`，调用 `obs_recall`/`update_plan` | 修复前会弹审批（或非交互模式下直接失败）；修复后应直接放行 |
| G7 | 制造一次确定性失败的压缩（例如 reducer/主模型不可用或压缩被取消），观察 `onError` 调用次数（在 `compactSession` 的 `onError` 里打日志） | 当前会打印两次，修复后一次 |
| G8 | 在 omp 里跑一次 reducer 收据（照 `docs/compatibility.md:157-158` 的方式），确认走的是 `getApiKeyAndHeaders` + pi-ai `complete` 分支 | 收据成功生成即路径可用；若要验证 base URL 差异，选一个 base URL 由 omp 设置而非模型自带的 provider 复现认证失败 |
| G9 | 在 TUI 会话里做一次带 `then_run` 的融合 `write`/`edit` | 修复前只显示 `write <path>` 一行；接线 `previewMutationCall` 后应显示参数派生预览（行数/替换对）+ `→ <command>` |
| G10 | 同上会话，观察 `obs_recall`/`update_plan` 行是否出现双重标题 | 纯观感确认，无需改动 |
| G11 | 按补写后的 `agents-install.md` 在 omp 上从零走一遍（`omp plugin install github:...omp-compat` → 写 `~/.omp/agent/sol-pi.json` → 启动会话） | 安装成功、配置生效、`omp` 启动无扩展加载错误 |
| G12 | 写一个最小 omp 冒烟清单：加载 → 四工具注册 → 融合写+`then_run` → `obs_recall` 分页 → RPC 边界压缩 | 逐项人工确认；不引入 vitest 内的 omp 模拟 |

另外建议的两项整体复验（成本低、覆盖 §1 的全部适配面）：

1. **18.3.0 全量复跑** `docs/compatibility.md:148-172` 的 18.2.6/18.2.7 清单（扩展加载与工具注册、融合 write/edit、ObservationPack 占位替换、reducer 收据、RPC 边界压缩、print 模式不压缩），把结论从 18.2.7 提升到 18.3.0。
2. **shim 导出面回归**：用 bun 直接 `import` 四个 shim（`legacy-pi-coding-agent-shim.ts`、`legacy-pi-ai-shim.ts`、`legacy-pi-tui-shim.ts`、`legacy-typebox.ts`）并断言 §1.1 列出的名字可解析——这是升级 omp 后最先会破的地方，且不需要模型。
