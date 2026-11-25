import { describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createTodoToolDefinition } from "../src/core/tools/todo.ts";

// The todo tool holds one checklist per instance; execute() is synchronous
// apart from the async declaration, so awaiting calls is enough to drive it.
async function run(
	tool: ReturnType<typeof createTodoToolDefinition>,
	input: Parameters<ReturnType<typeof createTodoToolDefinition>["execute"]>[1],
) {
	const result = await tool.execute("todo-1", input, undefined, undefined, {} as ExtensionToolContext);
	return result.details;
}

describe("todo tool", () => {
	it("sets the whole checklist", async () => {
		const tool = createTodoToolDefinition();
		const details = await run(tool, {
			action: "set",
			tasks: [
				{ text: "read files", done: false },
				{ text: "edit files", done: false },
			],
		});
		expect(details.tasks).toEqual([
			{ text: "read files", done: false },
			{ text: "edit files", done: false },
		]);
	});

	it("checks off one item by index", async () => {
		const tool = createTodoToolDefinition();
		await run(tool, {
			action: "set",
			tasks: [
				{ text: "a", done: false },
				{ text: "b", done: false },
			],
		});
		const details = await run(tool, { action: "check", index: 1, done: true });
		expect(details.tasks).toEqual([
			{ text: "a", done: false },
			{ text: "b", done: true },
		]);
	});

	it("unchecks an item", async () => {
		const tool = createTodoToolDefinition();
		await run(tool, { action: "set", tasks: [{ text: "a", done: true }] });
		const details = await run(tool, { action: "check", index: 0, done: false });
		expect(details.tasks).toEqual([{ text: "a", done: false }]);
	});

	it("replaces the previous checklist on a new task", async () => {
		const tool = createTodoToolDefinition();
		await run(tool, { action: "set", tasks: [{ text: "old", done: true }] });
		const details = await run(tool, { action: "set", tasks: [{ text: "new", done: false }] });
		expect(details.tasks).toEqual([{ text: "new", done: false }]);
	});

	it("rejects an out-of-range index", async () => {
		const tool = createTodoToolDefinition();
		await run(tool, { action: "set", tasks: [{ text: "a", done: false }] });
		await expect(run(tool, { action: "check", index: 3, done: true })).rejects.toThrow("out of range");
	});
});
