import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDiagnostics } from "../../ts-morph/get-diagnostics/get-diagnostics";
import type { DiagnosticInfo } from "../../ts-morph/get-diagnostics/types";
import logger from "../../utils/logger";

function safeLogError(error: unknown, toolArgs: Record<string, unknown>): void {
	try {
		logger.error(
			{ err: error, toolArgs },
			"Error executing get_diagnostics_by_tsmorph",
		);
	} catch (loggerErr) {
		console.error("Failed to write error log:", loggerErr);
	}
}

function safeLogInfo(fields: Record<string, unknown>): void {
	try {
		logger.info(fields, "get_diagnostics_by_tsmorph tool finished");
	} catch (loggerErr) {
		console.error("Failed to write info log:", loggerErr);
	}
}

function formatLocation(d: DiagnosticInfo): string {
	if (d.filePath === undefined) return "(global)";
	if (d.line === undefined) return d.filePath;
	return `${d.filePath}:${d.line}:${d.column ?? 0}`;
}

function formatDiagnostic(d: DiagnosticInfo): string {
	return `${d.category} TS${d.code} ${formatLocation(d)} — ${d.message}`;
}

export function registerGetDiagnosticsTool(server: McpServer): void {
	server.tool(
		"get_diagnostics_by_tsmorph",
		`[ts-morph] Return the TypeScript pre-emit diagnostics (syntactic + semantic type errors, warnings, and suggestions) for specific files or the whole project, computed from the project's tsconfig.

## When to use
- Validating that an edit/refactor did not introduce type errors, without spawning a separate \`tsc\` process.
- Getting the exact location + code + message of type errors to fix them.

## When NOT to use
- Inspecting the type at a single position — use \`get_type_at_position_by_tsmorph\`.
- Listing unused exports/imports — use \`find_unused_exports_by_tsmorph\` / \`organize_imports_by_tsmorph\`.

## Behavior
- Uses \`getPreEmitDiagnostics\` (the same set \`tsc --noEmit\` would report, minus emit-only errors).
- Diagnostics are sorted error → warning → suggestion → message, then by file and position.
- When \`filePaths\` is omitted, the whole project is checked (including global diagnostics with no file).

## Critical constraints
- All paths (\`tsconfigPath\`, \`filePaths\`) MUST be absolute.
- Reported \`line\`/\`column\` are 1-based.
- Results are capped at \`maxResults\` (default 100); \`truncated\` indicates whether more exist.

## Result
A summary (total/error/warning counts) plus one line per diagnostic: \`<category> TS<code> <file>:<line>:<col> — <message>\`. A file-level diagnostic with no specific position renders as just \`<file>\`, and a project-global diagnostic (no associated file) renders as \`(global)\`.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			filePaths: z
				.array(z.string())
				.optional()
				.describe(
					"Absolute paths of files to diagnose. Omit to check the whole project.",
				),
			maxResults: z
				.number()
				.int()
				.positive()
				.optional()
				.default(100)
				.describe("Maximum number of diagnostics to return (default 100)."),
		},
		async (args) => {
			const startTime = performance.now();
			let message = "";
			let isError = false;
			let duration = "0.00";

			const logArgs = {
				fileCount: args.filePaths?.length ?? "all",
				maxResults: args.maxResults,
			};

			try {
				const result = getDiagnostics({
					tsconfigPath: args.tsconfigPath,
					filePaths: args.filePaths,
					maxResults: args.maxResults,
				});

				const header = `Diagnostics: ${result.totalCount} total (${result.errorCount} error(s), ${result.warningCount} warning(s))${
					result.truncated
						? ` — showing first ${result.diagnostics.length}`
						: ""
				}`;
				const body =
					result.diagnostics.length > 0
						? result.diagnostics.map(formatDiagnostic).join("\n")
						: "(No diagnostics)";
				message = `${header}\n${body}`;
			} catch (error) {
				safeLogError(error, logArgs);
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				message = `Error: ${errorMessage}`;
				isError = true;
			} finally {
				const endTime = performance.now();
				duration = ((endTime - startTime) / 1000).toFixed(2);
				safeLogInfo({
					status: isError ? "Failure" : "Success",
					durationMs: Number.parseFloat((endTime - startTime).toFixed(2)),
					...logArgs,
				});
				try {
					logger.flush();
				} catch (flushErr) {
					console.error("Failed to flush logs:", flushErr);
				}
			}

			const finalMessage = `${message}\nStatus: ${
				isError ? "Failure" : "Success"
			}\nProcessing time: ${duration} seconds`;

			return {
				content: [{ type: "text", text: finalMessage }],
				isError,
			};
		},
	);
}
