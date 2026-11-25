// Todo tool: the model maintains one task checklist per assignment. `set`
// replaces the whole checklist (used when starting a new task), `check`
// toggles one entry. State lives in the tool instance, so it is scoped to
// the session that created the tool.
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

const todoTaskSchema = Type.Object({
	text: Type.String({ minLength: 1, description: "Task description shown in the UI" }),
	done: Type.Boolean({ description: "Whether the task is completed" }),
});

// Tagged union: the model picks the action by the `action` tag, not by
// positional or boolean flags.
const todoSchema = Type.Union([
	Type.Object(
		{
			action: Type.Literal("set"),
			tasks: Type.Array(todoTaskSchema, {
				minItems: 1,
				description: "Complete checklist for the task, in execution order",
			}),
		},
		{ description: "Replace the whole checklist with this task list. Call when starting a new task." },
	),
	Type.Object(
		{
			action: Type.Literal("check"),
			index: Type.Number({ minimum: 0, description: "Zero-based index of the task to toggle" }),
			done: Type.Boolean({ description: "Target state: true to check, false to uncheck" }),
		},
		{ description: "Toggle one entry of the current checklist by its index." },
	),
]);

export type TodoToolInput = Static<typeof todoSchema>;
export type TodoTask = Static<typeof todoTaskSchema>;

export interface TodoToolDetails {
	tasks: TodoTask[];
}

export const todoToolSystemPromptContribution = {
	snippet: "Write the task checklist for the current task",
	guidelines: [
		'Every task with more than one step starts with todo: call it with action "set" before any other tool, listing the full checklist in execution order.',
		'After each step completes, call todo with action "check" for that step\'s index; do not batch the checks to the end.',
		'A new task replaces the checklist: call "set" again with the new task\'s items.',
		"Write checklist items in the language the user writes in: a Chinese request gets Chinese items, not English ones.",
	],
} as const;

interface TodoState {
	tasks: TodoTask[];
}

// Results are copied out: the session log keeps the result object it was
// given, so later `check` calls must not mutate an earlier result.
function snapshot(state: TodoState): TodoToolDetails {
	return { tasks: state.tasks.map((task) => ({ ...task })) };
}

/**
 * Creates the `todo` tool definition. The checklist is held per tool
 * instance, so one instance per session gives per-session checklists.
 */
export function createTodoToolDefinition(): ToolDefinition<typeof todoSchema, TodoToolDetails> {
	const state: TodoState = { tasks: [] };
	return {
		name: "todo",
		label: "todo",
		description: `Write and track the task checklist shown in a side panel. Start every multi-step task by calling this with action "set" to lay out the full checklist in the user's language, then call it with action "check" and the step index as each step completes. One checklist per task: a new task replaces the previous one.`,
		promptSnippet: todoToolSystemPromptContribution.snippet,
		promptGuidelines: [...todoToolSystemPromptContribution.guidelines],
		parameters: todoSchema,
		async execute(_toolCallId, params: TodoToolInput, _signal?: AbortSignal, _onUpdate?, _ctx?: ExtensionContext) {
			switch (params.action) {
				case "set": {
					state.tasks = params.tasks.map((t) => ({ text: t.text, done: t.done }));
					const done = state.tasks.filter((t) => t.done).length;
					return {
						content: [
							{
								type: "text",
								text: `Checklist set: ${state.tasks.length} task(s), ${done} already done.`,
							},
						],
						details: snapshot(state),
					};
				}
				case "check": {
					if (params.index >= state.tasks.length) {
						throw new Error(
							state.tasks.length === 0
								? 'No checklist for this task yet: call todo with action "set" first.'
								: `Index ${params.index} out of range: checklist has ${state.tasks.length} task(s).`,
						);
					}
					const task = state.tasks[params.index];
					task.done = params.done;
					const done = state.tasks.filter((t) => t.done).length;
					return {
						content: [
							{
								type: "text",
								text: `${task.text} ${task.done ? "checked" : "unchecked"} (${done}/${state.tasks.length} done).`,
							},
						],
						details: snapshot(state),
					};
				}
			}
		},
	};
}

/** Creates the `todo` tool as an AgentTool for the core runtime. */
export function createTodoTool(): TypeBoxAgentTool<typeof todoSchema, TodoToolDetails> {
	return wrapToolDefinition(createTodoToolDefinition());
}
