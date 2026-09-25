/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Oh My Pi compatibility surface check.
 *
 * On omp, SoL-Pi is served by omp's legacy-Pi compatibility shims rather than
 * the real @earendil-works/* packages, so scripts/check-pi-compat.mjs proves
 * nothing about an omp installation. This script imports the installed shim
 * modules directly and asserts every runtime export SoL-Pi relies on plus the
 * host capabilities the adaptation layer branches on. Run it with bun:
 *
 *   bun scripts/check-omp-compat.mjs
 *
 * Set OMP_CODING_AGENT_DIR to the @oh-my-pi/pi-coding-agent package root when
 * omp is not in the global bun or npm install.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const failures = [];

function check(name, ok) {
	if (ok) {
		console.log(`ok   ${name}`);
	} else {
		failures.push(name);
		console.log(`FAIL ${name}`);
	}
}

function packageRoot() {
	const candidates = [
		process.env.OMP_CODING_AGENT_DIR,
		join(homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent"),
	];
	try {
		candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@oh-my-pi/pi-coding-agent"));
	} catch {
		// npm not on PATH; the bun candidate above is the common install.
	}
	const root = candidates.find((candidate) => candidate && existsSync(join(candidate, "package.json")));
	if (!root) {
		throw new Error(
			"Could not find an Oh My Pi installation. Set OMP_CODING_AGENT_DIR to the @oh-my-pi/pi-coding-agent package root.",
		);
	}
	return root;
}

const root = packageRoot();
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
console.log(`omp pi-coding-agent ${version} at ${root}`);

const agent = await import(pathToFileURL(join(root, "src/extensibility/legacy-pi-coding-agent-shim.ts")).href);
const ai = await import(pathToFileURL(join(root, "src/extensibility/legacy-pi-ai-shim.ts")).href);
const tui = await import(pathToFileURL(join(root, "src/extensibility/legacy-pi-tui-shim.ts")).href);
const typebox = await import(pathToFileURL(join(root, "src/extensibility/legacy-typebox.ts")).href);

// Every runtime value SoL-Pi imports from @earendil-works/pi-coding-agent.
for (const name of [
	"createBashToolDefinition",
	"createEditToolDefinition",
	"createWriteToolDefinition",
	"buildSessionContext",
	"estimateTokens",
	"findCutPoint",
	"sessionEntryToContextMessages",
	"getAgentDir",
	"ModelRegistry",
	"SessionManager",
]) {
	check(`pi-coding-agent export: ${name}`, typeof agent[name] === "function");
}
check("pi-coding-agent export: CONFIG_DIR_NAME", typeof agent.CONFIG_DIR_NAME === "string");
check("pi-ai export: complete", typeof ai.complete === "function");
for (const name of ["Text", "Container"]) {
	check(`pi-tui export: ${name}`, typeof tui[name] === "function");
}
check("typebox export: Type.Object", typeof typebox.Type?.Object === "function");

// Host capabilities the adaptation layer branches on.
check("ModelRegistry.prototype.getApiKeyAndHeaders", typeof agent.ModelRegistry?.prototype?.getApiKeyAndHeaders === "function");
check("ModelRegistry.prototype.getProviderBaseUrl", typeof agent.ModelRegistry?.prototype?.getProviderBaseUrl === "function");
check(
	"SessionManager.prototype.getArtifactPath (Evidence-Preserving Reducer reads truncated output through it)",
	typeof agent.SessionManager?.prototype?.getArtifactPath === "function",
);
check(
	"SessionManager.prototype.getSessionDir / getSessionId",
	typeof agent.SessionManager?.prototype?.getSessionDir === "function" &&
		typeof agent.SessionManager?.prototype?.getSessionId === "function",
);
check("CONFIG_DIR_NAME is .omp", agent.CONFIG_DIR_NAME === ".omp");
check("getAgentDir() resolves under the omp home", String(agent.getAgentDir?.() ?? "").includes(".omp"));

// omp has no registry.complete; SoL-Pi authenticates through getApiKeyAndHeaders
// there. Report it, but do not fail: a future omp that adds it is compatible.
console.log(
	`info ModelRegistry.prototype.complete: ${typeof agent.ModelRegistry?.prototype?.complete === "function" ? "present" : "absent (expected on omp; the reducer uses getApiKeyAndHeaders)"}`,
);

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed against omp ${version}.`);
	process.exit(1);
}
console.log(`\nAll checks passed against omp ${version}.`);
