export interface OrganizeImportsParams {
	tsconfigPath: string;
	/**
	 * Absolute paths of files to organize. When omitted (or empty), every
	 * non-declaration source file in the project is organized.
	 */
	filePaths?: string[];
	/** When true, compute the changes without writing them to disk. */
	dryRun?: boolean;
}

export interface OrganizeImportsResult {
	/** Absolute paths of files that were (or, in dryRun, would be) modified. */
	changedFiles: string[];
	/** Number of files examined/organized. */
	organizedFileCount: number;
}
