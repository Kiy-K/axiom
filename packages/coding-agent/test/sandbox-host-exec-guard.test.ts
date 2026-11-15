import { describe, expect, it } from "vitest";
import { assertHostExecAllowed } from "../src/core/sandbox/host-exec-guard.ts";

describe("assertHostExecAllowed", () => {
	it("allows everything when sandbox mode is off", () => {
		expect(() => assertHostExecAllowed("bash", { sandboxMode: false, hostExecGranted: new Set() })).not.toThrow();
	});

	it("blocks a route without a grant and names it", () => {
		expect(() => assertHostExecAllowed("mcp-stdio", { sandboxMode: true, hostExecGranted: new Set() })).toThrow(
			/"mcp-stdio".*sandbox mode is on/,
		);
	});

	it("allows only the granted route", () => {
		const policy = { sandboxMode: true, hostExecGranted: new Set(["package-install"] as const) };
		expect(() => assertHostExecAllowed("package-install", policy)).not.toThrow();
		expect(() => assertHostExecAllowed("bash", policy)).toThrow();
	});
});
