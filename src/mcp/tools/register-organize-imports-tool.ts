import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { organizeImports } from "../../ts-morph/organize-imports/organize-imports";
import logger from "../../utils/logger";

export function registerOrganizeImportsTool(server: McpServer): void {
	server.tool(
		"organize_imports_by_tsmorph",
		`[ts-morph] Run the "Organize Imports" action — remove unused imports, sort them, and coalesce multiple imports from the same module — on specific files or the whole project.

## When to use
- Cleaning up after edits that left unused imports behind (e.g. after deleting code or moving symbols).
- Normalizing import order/formatting across a set of files in one pass.

## When NOT to use
- Removing unused *exports* (use \`find_unused_exports_by_tsmorph\`).
- Adding a missing import for an undefined symbol (organize only removes/sorts existing imports).

## Behavior
- Removes unused named imports (and whole import declarations that become empty).
- Sorts and coalesces imports from the same module specifier.
- Keeps side-effect-only imports (\`import "./x"\`).
- Uses the TypeScript language service, so usage in JSX, types, and decorators is taken into account.

## Critical constraints
- All paths (\`tsconfigPath\`, \`filePaths\`) MUST be absolute.
- When \`filePaths\` is omitted, EVERY non-declaration source file in the project is organized — this can produce a large diff. Prefer passing the specific files you touched, and/or run with \`dryRun: true\` first.
- Organize Imports reorders imports; expect ordering-only diffs even when nothing was unused.

## Result
Returns the number of files organized and the list of modified (or, in dryRun, to-be-modified) file paths.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			filePaths: z
				.array(z.string())
				.optional()
				.describe(
					"Absolute paths of files to organize. Omit to organize every non-declaration source file in the project.",
				),
			dryRun: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"If true, only show intended changes without modifying files.",
				),
		},
		async (args) => {
			const startTime = performance.now();
			let message = "";
			let isError = false;
			let duration = "0.00";
			let changedFilesCount = 0;

			const logArgs = {
				fileCount: args.filePaths?.length ?? "all",
				dryRun: args.dryRun,
			};

			try {
				const result = await organizeImports({
					tsconfigPath: args.tsconfigPath,
					filePaths: args.filePaths,
					dryRun: args.dryRun,
				});

				changedFilesCount = result.changedFiles.length;
				const changedFilesList =
					result.changedFiles.length > 0
						? result.changedFiles.join("\n - ")
						: "(No changes)";
				const summary = `Organized ${result.organizedFileCount} file(s); ${result.changedFiles.length} changed.`;

				if (args.dryRun) {
					message = `Dry run complete: ${summary}\nWould modify the following files:\n - ${changedFilesList}`;
				} else {
					message = `Organize imports successful: ${summary}\nThe following files were modified:\n - ${changedFilesList}`;
				}
			} catch (error) {
				logger.error(
					{ err: error, toolArgs: logArgs },
					"Error executing organize_imports_by_tsmorph",
				);
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				message = `Error during organize_imports: ${errorMessage}`;
				isError = true;
			} finally {
				const endTime = performance.now();
				duration = ((endTime - startTime) / 1000).toFixed(2);
				logger.info(
					{
						status: isError ? "Failure" : "Success",
						durationMs: Number.parseFloat((endTime - startTime).toFixed(2)),
						changedFilesCount,
						...logArgs,
					},
					"organize_imports_by_tsmorph tool finished",
				);
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
