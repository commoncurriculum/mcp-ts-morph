export interface GetDiagnosticsParams {
	tsconfigPath: string;
	/**
	 * Absolute paths of files to diagnose. When omitted (or empty), diagnostics
	 * for the whole project are returned (including global/no-file diagnostics).
	 */
	filePaths?: string[];
	/** Maximum number of diagnostics to return after sorting. Defaults to 100. */
	maxResults?: number;
}

export type DiagnosticCategoryLabel =
	| "error"
	| "warning"
	| "suggestion"
	| "message";

export interface DiagnosticInfo {
	/** Absolute path of the file the diagnostic belongs to (absent for global diagnostics). */
	filePath?: string;
	/** 1-based line number (absent when there is no associated position). */
	line?: number;
	/** 1-based column number (absent when there is no associated position). */
	column?: number;
	category: DiagnosticCategoryLabel;
	/** TypeScript diagnostic code (e.g. 2322). */
	code: number;
	message: string;
}

export interface GetDiagnosticsResult {
	diagnostics: DiagnosticInfo[];
	/** Total number of diagnostics found, before `maxResults` truncation. */
	totalCount: number;
	errorCount: number;
	warningCount: number;
	/** True when `diagnostics` was truncated to `maxResults`. */
	truncated: boolean;
}
