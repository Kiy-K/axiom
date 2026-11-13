// Scope- and time-limited grants for one session. A grant lets matching actions pass without a prompt until it expires or is revoked.

import { randomUUID } from "node:crypto";
import { isPathWithin } from "../../utils/paths.ts";
import type { Action, Grant, GrantScope } from "./types.ts";

/** How long a grant a user accepts at a prompt lasts. There is no standing grant. */
export const GRANT_TTL_MS = 10 * 60 * 1000;

/** Grants held by one session. Nothing is persisted: a resumed or new session starts with none. */
export class GrantStore {
	private readonly grants = new Map<string, Grant>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Add a grant for `scope` that expires `ttlMs` from now. */
	add(scope: GrantScope, ttlMs: number = GRANT_TTL_MS): Grant {
		const grant: Grant = { id: randomUUID().slice(0, 8), scope, expiresAt: this.now() + ttlMs };
		this.grants.set(grant.id, grant);
		return grant;
	}

	/** The live grant covering `action`, if any. */
	find(action: Action): Grant | undefined {
		return this.list().find((grant) => covers(grant.scope, action));
	}

	/** Revoke one grant. False when it is unknown or already expired. */
	revoke(id: string): boolean {
		return this.grants.delete(id);
	}

	/** Revoke every grant. Returns how many were live. */
	clear(): number {
		const live = this.list().length;
		this.grants.clear();
		return live;
	}

	/** Live grants, oldest first. Expired ones are dropped here. */
	list(): Grant[] {
		const now = this.now();
		for (const [id, grant] of this.grants) {
			if (grant.expiresAt <= now) this.grants.delete(id);
		}
		return [...this.grants.values()];
	}
}

function covers(scope: GrantScope, action: Action): boolean {
	switch (action.kind) {
		case "read":
		case "write":
			return scope.kind === action.kind && isPathWithin(scope.dir, action.path.real);
		case "exec":
			return scope.kind === "exec" && scope.command === action.command;
		case "extension":
			return scope.kind === "extension" && scope.toolName === action.toolName;
		case "unsupported":
		case "undetermined":
			return false;
	}
}
