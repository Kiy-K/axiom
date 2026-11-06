import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { McpOAuthCredentialStore, signInMcpServer } from "../src/extensions/mcp/oauth.ts";
import { startOAuthMcpServer } from "./suite/mcp-oauth-server.ts";

describe("MCP OAuth in a rebranded build", () => {
	const cleanups: (() => Promise<void>)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("registers dynamically by default with the app name instead of using pi's document", async () => {
		const server = await startOAuthMcpServer({ cimd: true, issParameter: true });
		cleanups.push(server.close);
		const store = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()).forServer("test", server.url);

		await signInMcpServer({
			serverUrl: server.url,
			store,
			settings: {},
			prompt: {
				showAuthorizationUrl: (url) => void fetch(url),
				promptForRedirectUrl: (signal) =>
					new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
			},
		});

		expect(APP_NAME).not.toBe("pi");
		expect(server.registrations).toMatchObject([{ client_name: APP_NAME }]);
		expect(server.authorizations[0].get("client_id")).toBe("client-1");
	});
});
