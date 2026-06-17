import {
	type ClassDeclaration,
	type ExportAssignment,
	type ExportSpecifier,
	type FunctionDeclaration,
	type ImportDeclaration,
	Node,
	type Project,
	type SourceFile,
} from "ts-morph";
import logger from "../../utils/logger";
import {
	getChangedFiles,
	initializeProject,
	saveProjectChanges,
} from "../_utils/ts-morph-project";
import type {
	ConvertDefaultExportToNamedParams,
	ConvertDefaultExportToNamedResult,
} from "./types";

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Converts a file's `export default` into a named export and rewrites every
 * importing/re-exporting site across the project.
 *
 * Initializes a project from `tsconfigPath` and delegates to
 * `convertDefaultExportToNamedOnProject`. Use that function directly when you
 * already have a `Project` (e.g. in tests).
 */
export async function convertDefaultExportToNamed(
	params: ConvertDefaultExportToNamedParams,
): Promise<ConvertDefaultExportToNamedResult> {
	const project = initializeProject(params.tsconfigPath);
	return convertDefaultExportToNamedOnProject(project, params);
}

/**
 * Internal API that applies the conversion to an existing `Project`.
 */
export async function convertDefaultExportToNamedOnProject(
	project: Project,
	{
		targetFilePath,
		newName,
		dryRun = false,
	}: Omit<ConvertDefaultExportToNamedParams, "tsconfigPath">,
): Promise<ConvertDefaultExportToNamedResult> {
	logger.debug(
		{ targetFilePath, newName, dryRun },
		"convertDefaultExportToNamed start",
	);

	const sourceFile = project.getSourceFile(targetFilePath);
	if (!sourceFile) throw new Error(`File not found: ${targetFilePath}`);

	if (newName !== undefined && !IDENTIFIER_RE.test(newName)) {
		throw new Error(`Invalid newName: '${newName}' is not a valid identifier`);
	}

	// Phase 1: convert the default export in the target file and learn its name.
	const exportName = convertTargetDefaultExport(sourceFile, newName);

	// Phase 2: rewrite default imports / default re-exports across the project.
	const { updatedImportSites, updatedReExportSites } = updateReferences(
		project,
		sourceFile,
		exportName,
	);

	const changedFiles = getChangedFiles(project).map((sf) => sf.getFilePath());
	logger.debug(
		{ exportName, updatedImportSites, updatedReExportSites, changedFiles },
		"convertDefaultExportToNamed apply complete",
	);

	if (!dryRun) {
		await saveProjectChanges(project);
		logger.info(
			{ targetFilePath, exportName, changedFileCount: changedFiles.length },
			"convertDefaultExportToNamed saved",
		);
	}

	return { changedFiles, exportName, updatedImportSites, updatedReExportSites };
}

/**
 * Converts the default export of `sourceFile` in place and returns the name of
 * the resulting named export. Throws for unsupported or anonymous-without-name
 * forms.
 */
function convertTargetDefaultExport(
	sourceFile: SourceFile,
	newName: string | undefined,
): string {
	const defaultSymbol = sourceFile.getDefaultExportSymbol();
	if (!defaultSymbol) {
		throw new Error(`No default export found in ${sourceFile.getFilePath()}`);
	}

	const declaration = defaultSymbol.getDeclarations()[0];
	if (!declaration) {
		throw new Error(
			`Could not resolve the default export declaration in ${sourceFile.getFilePath()}`,
		);
	}

	// `export default function foo() {}` / `export default class Foo {}`
	// (named or anonymous).
	if (
		Node.isFunctionDeclaration(declaration) ||
		Node.isClassDeclaration(declaration)
	) {
		return convertDeclaration(declaration, newName);
	}

	// `export default <expr>;`
	if (Node.isExportAssignment(declaration)) {
		return convertExportAssignment(declaration, newName);
	}

	// `export { foo as default };`
	if (Node.isExportSpecifier(declaration)) {
		return convertExportSpecifierDefault(declaration, newName);
	}

	throw new Error(
		`Unsupported default export form (${declaration.getKindName()}) in ${sourceFile.getFilePath()}`,
	);
}

function convertDeclaration(
	declaration: FunctionDeclaration | ClassDeclaration,
	newName: string | undefined,
): string {
	const currentName = declaration.getName();

	if (currentName) {
		if (newName !== undefined && newName !== currentName) {
			throw new Error(
				`The default export is already named '${currentName}'. Omit newName to keep it, or rename it first with rename_symbol_by_tsmorph (then convert).`,
			);
		}
		// `removeDefaultExport` (triggered by setIsDefaultExport(false)) strips BOTH
		// `default` and `export`, so re-add `export` to keep it exported by name.
		declaration.setIsDefaultExport(false);
		declaration.setIsExported(true);
		return currentName;
	}

	// Anonymous function/class declaration: it needs a name to be a named export.
	if (newName === undefined) {
		throw new Error(
			"The default export is anonymous; provide newName for the resulting named export.",
		);
	}
	// Reinterpret the anonymous declaration as an initializer so we can bind a
	// name without fragile in-place name insertion (handles generics/`extends`).
	// `getText()` excludes leading comments/JSDoc, which stay above the node.
	const fullText = declaration.getText();
	const initializer = fullText.replace(/^export\s+default\s+/, "");
	if (initializer === fullText) {
		throw new Error(
			`Unsupported anonymous default export form (${declaration.getKindName()}); declare it with a name first, then convert.`,
		);
	}
	declaration.replaceWithText(`export const ${newName} = ${initializer};`);
	return newName;
}

function convertExportAssignment(
	exportAssignment: ExportAssignment,
	newName: string | undefined,
): string {
	if (exportAssignment.isExportEquals()) {
		throw new Error(
			"`export =` is a CommonJS export assignment, not a default export; not supported.",
		);
	}

	const expression = exportAssignment.getExpression();

	// `export default foo;` — re-export the existing binding by name.
	if (Node.isIdentifier(expression)) {
		const localName = expression.getText();
		const finalName = newName ?? localName;
		const specifier =
			finalName === localName ? localName : `${localName} as ${finalName}`;
		exportAssignment.replaceWithText(`export { ${specifier} };`);
		return finalName;
	}

	// `export default <expr>;` (arrow function, object literal, call, literal, ...).
	if (newName === undefined) {
		throw new Error(
			"The default export is an anonymous expression; provide newName for the resulting named export.",
		);
	}
	exportAssignment.replaceWithText(
		`export const ${newName} = ${expression.getText()};`,
	);
	return newName;
}

function convertExportSpecifierDefault(
	specifier: ExportSpecifier,
	newName: string | undefined,
): string {
	// `export { foo as default }` → name node is `foo`, alias is `default`.
	const localName = specifier.getName();
	const finalName = newName ?? localName;
	if (finalName === localName) {
		specifier.removeAlias();
	} else {
		specifier.setAlias(finalName);
	}
	return finalName;
}

/**
 * Rewrites every default import and default re-export of `targetSourceFile`
 * across the project to reference `exportName` instead.
 */
function updateReferences(
	project: Project,
	targetSourceFile: SourceFile,
	exportName: string,
): { updatedImportSites: number; updatedReExportSites: number } {
	let updatedImportSites = 0;
	let updatedReExportSites = 0;

	for (const sourceFile of project.getSourceFiles()) {
		if (sourceFile === targetSourceFile) continue;

		// 1. Default imports: `import Foo from "target"` (possibly alongside
		//    named or namespace imports).
		for (const importDecl of sourceFile.getImportDeclarations()) {
			if (importDecl.getModuleSpecifierSourceFile() !== targetSourceFile) {
				continue;
			}
			const defaultImport = importDecl.getDefaultImport();
			if (!defaultImport) continue;

			rewriteDefaultImport(importDecl, defaultImport.getText(), exportName);
			updatedImportSites++;
		}

		// 2. Re-exports: `export { default } from "target"` /
		//    `export { default as X } from "target"`.
		for (const exportDecl of sourceFile.getExportDeclarations()) {
			if (exportDecl.getModuleSpecifierSourceFile() !== targetSourceFile) {
				continue;
			}
			for (const specifier of exportDecl.getNamedExports()) {
				if (specifier.getName() !== "default") continue;
				// Keeps any alias intact: `{ default as X }` → `{ exportName as X }`,
				// and `{ default }` → `{ exportName }`.
				specifier.setName(exportName);
				updatedReExportSites++;
			}
		}
	}

	return { updatedImportSites, updatedReExportSites };
}

function rewriteDefaultImport(
	importDecl: ImportDeclaration,
	localName: string,
	exportName: string,
): void {
	const namedImport =
		localName === exportName
			? { name: exportName }
			: { name: exportName, alias: localName };

	// A namespace import cannot share a declaration with named imports, so the
	// default must move into its own `import { ... }` declaration.
	const namespaceImport = importDecl.getNamespaceImport();

	if (namespaceImport) {
		const moduleSpecifier = importDecl.getModuleSpecifierValue();
		const isTypeOnly = importDecl.isTypeOnly();
		importDecl.removeDefaultImport();
		importDecl.getSourceFile().addImportDeclaration({
			moduleSpecifier,
			namedImports: [namedImport],
			isTypeOnly,
		});
		return;
	}

	importDecl.removeDefaultImport();
	importDecl.addNamedImport(namedImport);
}
