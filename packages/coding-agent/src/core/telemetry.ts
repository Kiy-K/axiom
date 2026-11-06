import { IS_OFFICIAL_DISTRIBUTION } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
): boolean {
	// Forks never report installs or attribute requests to upstream Pi.
	if (!IS_OFFICIAL_DISTRIBUTION) return false;
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
