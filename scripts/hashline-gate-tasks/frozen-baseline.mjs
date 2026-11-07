// Frozen P0 baseline bugfix tasks (scripts/baseline-tasks/tasks.mjs), run through the gate for pass, tokens,
// wall time and edit errors. They have no wrong-write guard, so this set does not measure wrong writes.

import { tasks as p0Tasks } from "../baseline-tasks/tasks.mjs";

export const tasks = p0Tasks
	.filter((task) => task.kind === "bugfix")
	.map((task) => ({
		id: `p0-${task.id}`,
		category: "p0-bugfix",
		prompt: task.prompt,
		files: task.files,
		oracle: () => task.fix,
		guard: () => [],
	}));
