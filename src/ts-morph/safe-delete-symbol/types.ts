export interface SafeDeleteSymbolParams {
	tsconfigPath: string;
	/** Absolute path of the file declaring the symbol. */
	targetFilePath: string;
	/** Name of the top-level symbol to delete. */
	symbolName: string;
	/** When true, compute the result without writing changes to disk. */
	dryRun?: boolean;
}

export interface BlockingReference {
	filePath: string;
	/** 1-based line number. */
	line: number;
	/** 1-based column number. */
	column: number;
	/** A short snippet of the referencing code. */
	text: string;
}

export interface SafeDeleteSymbolResult {
	/** True when the symbol had no external references and was deleted. */
	deleted: boolean;
	/** References that block deletion (empty when `deleted` is true). */
	blockingReferences: BlockingReference[];
	/** Absolute paths of files that were (or, in dryRun, would be) modified. */
	changedFiles: string[];
}
