import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "../src/core/settings-diagnostics.ts";
import { SettingsManager, type SettingsStorage } from "../src/core/settings-manager.ts";

describe("settings diagnostics", () => {
	it("includes the settings file path for file-backed storage", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-settings-diagnostics-"));
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		mkdirSync(agentDir);
		writeFileSync(settingsPath, "{");

		try {
			const diagnostics = collectSettingsDiagnostics(SettingsManager.create(tempDir, agentDir));

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.type).toBe("warning");
			expect(diagnostics[0]?.message).toContain(`Invalid settings file ${settingsPath}:`);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to the settings scope for storage without file paths", () => {
		const storage: SettingsStorage = {
			withLock(scope, fn) {
				if (scope === "global") throw new Error("backend failed");
				fn(undefined);
			},
		};
		const diagnostics = collectSettingsDiagnostics(SettingsManager.fromStorage(storage));

		expect(diagnostics).toEqual([{ type: "warning", message: "Invalid global settings: backend failed" }]);
	});

	describe("permissionMode", () => {
		const diagnosticsFor = (globalFile: string) => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-settings-diagnostics-"));
			const agentDir = join(tempDir, "agent");
			mkdirSync(agentDir);
			writeFileSync(join(agentDir, "settings.json"), globalFile);
			try {
				return collectSettingsDiagnostics(SettingsManager.create(tempDir, agentDir));
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		};

		it("tells a user of the former unrestricted value that it now runs as manual", () => {
			const diagnostics = diagnosticsFor('{"permissionMode":"unrestricted"}');

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.type).toBe("warning");
			expect(diagnostics[0]?.message).toContain('"unrestricted" was renamed "yolo"');
			expect(diagnostics[0]?.message).toContain('running in "manual" mode');
		});

		it("names an unrecognized value, and escapes control characters in it", () => {
			const diagnostics = diagnosticsFor('{"permissionMode":"stric\\u001b[2Jt"}');

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.message).toContain("not recognized");
			expect(diagnostics[0]?.message).not.toContain("\u001b");
		});

		it("is silent for unset and valid values", () => {
			for (const file of [
				"{}",
				'{"permissionMode":"yolo"}',
				'{"permissionMode":"manual"}',
				'{"permissionMode":"accept-edits"}',
				'{"permissionMode":"auto"}',
			])
				expect(diagnosticsFor(file)).toEqual([]);
		});

		it("reports only the parse error when the file is unreadable, not a second notice about the value", () => {
			const diagnostics = diagnosticsFor('{"permissionMode":"unrestricted"');

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.message).toContain("Invalid settings file");
		});
	});

	it("deduplicates diagnostics by type and message", () => {
		const warning = { type: "warning" as const, message: "Invalid settings file /tmp/settings.json" };

		expect(deduplicateDiagnostics([warning, warning, { ...warning, type: "error" }])).toEqual([
			warning,
			{ ...warning, type: "error" },
		]);
	});
});
