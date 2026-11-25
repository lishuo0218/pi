/**
 * Presentation for the todo tool.
 *
 * Renderers live apart from the implementation so a process that only
 * displays tool output does not load the execution path or its typebox
 * parameter schema.
 */

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { TodoToolDetails } from "../todo.ts";

type TodoRenderArgs =
	| { action: "set"; tasks: Array<{ text: string; done: boolean }> }
	| { action: "check"; index: number; done: boolean };

function formatTodoCall(args: TodoRenderArgs | undefined, theme: Theme): string {
	const title = theme.fg("toolTitle", theme.bold("todo"));
	if (!args) return title;
	if (args.action === "set") {
		return `${title} ${theme.fg("toolOutput", `set ${args.tasks.length} task(s)`)}`;
	}
	return `${title} ${theme.fg("toolOutput", `${args.done ? "check" : "uncheck"} #${args.index}`)}`;
}

function formatTodoResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: TodoToolDetails;
	},
	theme: Theme,
): string {
	const tasks = result.details?.tasks ?? [];
	if (tasks.length === 0) return "";
	const lines = tasks.map((task) =>
		task.done ? theme.fg("success", `✓ ${task.text}`) : theme.fg("toolOutput", `○ ${task.text}`),
	);
	return `\n${lines.join("\n")}`;
}

export const todoRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatTodoCall(args as TodoRenderArgs, theme));
		return text;
	},
	renderResult(result, _options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatTodoResult(result as any, theme));
		return text;
	},
};
