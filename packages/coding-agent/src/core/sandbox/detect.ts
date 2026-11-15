// Checks whether this machine can run a Gondolin VM at all, before any VM is started.

import { accessSync, constants } from "node:fs";
import { hasGuestAssets } from "@earendil-works/gondolin";

export type SandboxSupport = { ok: true; imageCached: boolean } | { ok: false; reason: string };

/** Linux needs a usable /dev/kvm; other platforms use Gondolin's own backend and are left to the start probe. */
export function detectSandboxSupport(platform: NodeJS.Platform = process.platform): SandboxSupport {
	if (platform === "linux") {
		try {
			accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
		} catch {
			return { ok: false, reason: "/dev/kvm is not accessible; hardware virtualization is required" };
		}
	}
	// A missing image is downloaded on first start (~30s), so it is reported, not refused.
	return { ok: true, imageCached: hasGuestAssets() };
}
