/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CACHE_WRITE_READ_RATIO,
	cacheWriteReadRatioFromModel,
	effectiveCacheWriteReadRatio,
	resolveCacheWriteReadRatioOption,
} from "../src/sol-pi/extensions/online-context-compact/model-ratio.ts";

describe("cache write/read ratio from model prices", () => {
	it("derives the ratio the breakeven formula works in", () => {
		// Anthropic-shaped pricing: reads at 0.1x base input, writes at 1.25x.
		expect(cacheWriteReadRatioFromModel({ cost: { input: 3, cacheRead: 0.3, cacheWrite: 3.75 } })).toBe(12.5);
		// A rate card with no separate write rate bills the rewritten prompt
		// tokens at the input rate, so the write side is the input price.
		expect(cacheWriteReadRatioFromModel({ cost: { input: 0.15, cacheRead: 0.003, cacheWrite: 0 } })).toBe(50);
		expect(cacheWriteReadRatioFromModel({ cost: { input: 1, cacheRead: 0.2, cacheWrite: 0 } })).toBe(5);
		// Writes and reads at the same price: the rewrite costs nothing extra.
		expect(cacheWriteReadRatioFromModel({ cost: { input: 1, cacheRead: 1, cacheWrite: 1 } })).toBe(1);
	});

	it("reports no ratio for models without usable cache prices", () => {
		expect(cacheWriteReadRatioFromModel(undefined)).toBeUndefined();
		expect(cacheWriteReadRatioFromModel({})).toBeUndefined();
		// Zeroed rows are the host catalog's "pricing unknown" marker.
		expect(cacheWriteReadRatioFromModel({ cost: { cacheRead: 0, cacheWrite: 0 } })).toBeUndefined();
		expect(cacheWriteReadRatioFromModel({ cost: { cacheRead: 0, cacheWrite: 3.75 } })).toBeUndefined();
		expect(cacheWriteReadRatioFromModel({ cost: { cacheRead: 0.3 } })).toBeUndefined();
		// A write rate that no longer exists anywhere in the row stays unknown
		// instead of reading as a free write.
		expect(cacheWriteReadRatioFromModel({ cost: { cacheRead: 0.003, cacheWrite: 0 } })).toBeUndefined();
		expect(cacheWriteReadRatioFromModel({ cost: { input: 0, cacheRead: 0.003, cacheWrite: 0 } })).toBeUndefined();
		expect(cacheWriteReadRatioFromModel({ cost: { input: 3, cacheRead: 0.3, cacheWrite: -1 } })).toBe(10);
		expect(cacheWriteReadRatioFromModel({ cost: { cacheRead: Number.NaN, cacheWrite: 1 } })).toBeUndefined();
	});

	it("resolves the configured policy", () => {
		expect(resolveCacheWriteReadRatioOption(undefined)).toBe("auto");
		expect(resolveCacheWriteReadRatioOption("auto")).toBe("auto");
		expect(resolveCacheWriteReadRatioOption(null)).toBeNull();
		expect(resolveCacheWriteReadRatioOption(0)).toBe(0);
		expect(resolveCacheWriteReadRatioOption(3.25)).toBe(3.25);
		for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => resolveCacheWriteReadRatioOption(invalid)).toThrow(/must be "auto" or finite and non-negative/u);
		}
	});

	it("prefers configured numbers, then model prices, then the fallback", () => {
		const model = { cost: { input: 3, cacheRead: 0.3, cacheWrite: 3.75 } };
		expect(effectiveCacheWriteReadRatio(4, model)).toBe(4);
		expect(effectiveCacheWriteReadRatio(0, model)).toBe(0);
		expect(effectiveCacheWriteReadRatio(null, model)).toBeNull();
		expect(effectiveCacheWriteReadRatio("auto", model)).toBe(12.5);
		expect(effectiveCacheWriteReadRatio("auto", { cost: { input: 0.15, cacheRead: 0.003, cacheWrite: 0 } })).toBe(50);
		expect(effectiveCacheWriteReadRatio("auto", undefined)).toBe(DEFAULT_CACHE_WRITE_READ_RATIO);
		expect(effectiveCacheWriteReadRatio("auto", { cost: { cacheRead: 0, cacheWrite: 0 } })).toBe(
			DEFAULT_CACHE_WRITE_READ_RATIO,
		);
	});
});
