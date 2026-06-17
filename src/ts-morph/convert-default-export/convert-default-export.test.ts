import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import { getFileText } from "../_test-utils/get-file-text";
import { convertDefaultExportToNamedOnProject } from "./convert-default-export";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	return project;
}

describe("convertDefaultExportToNamed", () => {
	describe("target file conversion", () => {
		it("converts a named function default export, keeping its name", async () => {
			const project = setup({
				"/src/button.ts":
					"export default function Button() {\n\treturn 1;\n}\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.exportName).toBe("Button");
			expect(getFileText(project, "/src/button.ts")).toBe(
				"export function Button() {\n\treturn 1;\n}\n",
			);
		});

		it("converts a named class default export, keeping its name", async () => {
			const project = setup({
				"/src/widget.ts": "export default class Widget {}\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/widget.ts",
			});

			expect(result.exportName).toBe("Widget");
			expect(getFileText(project, "/src/widget.ts")).toBe(
				"export class Widget {}\n",
			);
		});

		it("converts `export default <identifier>` to a named re-export", async () => {
			const project = setup({
				"/src/value.ts": "const value = 42;\nexport default value;\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/value.ts",
			});

			expect(result.exportName).toBe("value");
			expect(getFileText(project, "/src/value.ts")).toBe(
				"const value = 42;\nexport { value };\n",
			);
		});

		it("renames `export default <identifier>` when newName differs", async () => {
			const project = setup({
				"/src/value.ts": "const v = 42;\nexport default v;\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/value.ts",
				newName: "answer",
			});

			expect(result.exportName).toBe("answer");
			expect(getFileText(project, "/src/value.ts")).toBe(
				"const v = 42;\nexport { v as answer };\n",
			);
		});

		it("converts an anonymous arrow expression with newName", async () => {
			const project = setup({
				"/src/fn.ts": "export default () => 1;\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/fn.ts",
				newName: "fn",
			});

			expect(result.exportName).toBe("fn");
			expect(getFileText(project, "/src/fn.ts")).toBe(
				"export const fn = () => 1;\n",
			);
		});

		it("converts an anonymous object-literal expression with newName", async () => {
			const project = setup({
				"/src/config.ts": "export default { a: 1, b: 2 };\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/config.ts",
				newName: "config",
			});

			expect(result.exportName).toBe("config");
			expect(getFileText(project, "/src/config.ts")).toBe(
				"export const config = { a: 1, b: 2 };\n",
			);
		});

		it("converts an anonymous function declaration with newName", async () => {
			const project = setup({
				"/src/fn.ts": "export default function () {\n\treturn 1;\n}\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/fn.ts",
				newName: "run",
			});

			expect(result.exportName).toBe("run");
			expect(getFileText(project, "/src/fn.ts")).toBe(
				"export const run = function () {\n\treturn 1;\n};\n",
			);
		});

		it("converts an anonymous class declaration with `extends` and newName", async () => {
			const project = setup({
				"/src/base.ts": "export class Base {}\n",
				"/src/widget.ts":
					'import { Base } from "./base";\nexport default class extends Base {}\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/widget.ts",
				newName: "Widget",
			});

			expect(result.exportName).toBe("Widget");
			expect(getFileText(project, "/src/widget.ts")).toBe(
				'import { Base } from "./base";\nexport const Widget = class extends Base {};\n',
			);
		});

		it("converts `export { foo as default }` to a named export", async () => {
			const project = setup({
				"/src/value.ts": "const foo = 1;\nexport { foo as default };\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/value.ts",
			});

			expect(result.exportName).toBe("foo");
			expect(getFileText(project, "/src/value.ts")).toBe(
				"const foo = 1;\nexport { foo };\n",
			);
		});
	});

	describe("importer rewriting", () => {
		it("rewrites a sole default import to a named import", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/app.ts": 'import Button from "./button";\nButton();\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedImportSites).toBe(1);
			expect(getFileText(project, "/src/app.ts")).toBe(
				'import { Button } from "./button";\nButton();\n',
			);
		});

		it("aliases the named import when the local name differs", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/app.ts": 'import Btn from "./button";\nBtn();\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(getFileText(project, "/src/app.ts")).toBe(
				'import { Button as Btn } from "./button";\nBtn();\n',
			);
		});

		it("merges into an existing named import on the same declaration", async () => {
			const project = setup({
				"/src/button.ts":
					"export default function Button() {}\nexport const size = 1;\n",
				"/src/app.ts":
					'import Button, { size } from "./button";\nButton();\nconsole.log(size);\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			const app = project.getSourceFileOrThrow("/src/app.ts");
			const importDecl = app.getImportDeclarations()[0];
			expect(importDecl.getDefaultImport()).toBeUndefined();
			expect(importDecl.getNamedImports().map((n) => n.getText())).toEqual([
				"size",
				"Button",
			]);
		});

		it("splits into a separate declaration when a namespace import is present", async () => {
			const project = setup({
				"/src/button.ts":
					"export default function Button() {}\nexport const size = 1;\n",
				"/src/app.ts":
					'import Button, * as btn from "./button";\nButton();\nconsole.log(btn.size);\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			const app = project.getSourceFileOrThrow("/src/app.ts");
			const decls = app.getImportDeclarations();
			// Original declaration keeps the namespace import, default removed.
			const namespaceDecl = decls.find((d) => d.getNamespaceImport());
			expect(namespaceDecl?.getDefaultImport()).toBeUndefined();
			// A new declaration carries the named import.
			const namedDecl = decls.find((d) => d.getNamedImports().length > 0);
			expect(namedDecl?.getModuleSpecifierValue()).toBe("./button");
			expect(namedDecl?.getNamedImports().map((n) => n.getText())).toEqual([
				"Button",
			]);
		});

		it("preserves a type-only default import", async () => {
			const project = setup({
				"/src/types.ts":
					"type Options = { id: number };\nexport default Options;\n",
				"/src/app.ts":
					'import type Options from "./types";\nconst o: Options = { id: 1 };\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/types.ts",
			});

			const app = project.getSourceFileOrThrow("/src/app.ts");
			const importDecl = app.getImportDeclarations()[0];
			expect(importDecl.isTypeOnly()).toBe(true);
			expect(importDecl.getDefaultImport()).toBeUndefined();
			expect(importDecl.getNamedImports().map((n) => n.getText())).toEqual([
				"Options",
			]);
		});

		it("resolves default imports written through a path alias", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/app.ts": 'import Button from "@/button";\nButton();\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedImportSites).toBe(1);
			expect(getFileText(project, "/src/app.ts")).toBe(
				'import { Button } from "@/button";\nButton();\n',
			);
		});

		it("updates default imports across multiple files", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/a.ts": 'import Button from "./button";\nButton();\n',
				"/src/b.ts": 'import B from "./button";\nB();\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedImportSites).toBe(2);
			expect(getFileText(project, "/src/a.ts")).toBe(
				'import { Button } from "./button";\nButton();\n',
			);
			expect(getFileText(project, "/src/b.ts")).toBe(
				'import { Button as B } from "./button";\nB();\n',
			);
		});
	});

	describe("re-export rewriting", () => {
		it("rewrites `export { default } from` to a named re-export", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/index.ts": 'export { default } from "./button";\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedReExportSites).toBe(1);
			expect(getFileText(project, "/src/index.ts")).toBe(
				'export { Button } from "./button";\n',
			);
		});

		it("rewrites `export { default as X } from`, keeping the alias", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/index.ts": 'export { default as Btn } from "./button";\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedReExportSites).toBe(1);
			expect(getFileText(project, "/src/index.ts")).toBe(
				'export { Button as Btn } from "./button";\n',
			);
		});
	});

	describe("dryRun", () => {
		it("reports changes without saving", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/app.ts": 'import Button from "./button";\nButton();\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
				dryRun: true,
			});

			expect(result.changedFiles.sort()).toEqual([
				"/src/app.ts",
				"/src/button.ts",
			]);
			// Nothing has been persisted to the (in-memory) file system yet.
			expect(
				project.getSourceFiles().filter((sf) => !sf.isSaved()).length,
			).toBeGreaterThan(0);
		});
	});

	describe("errors", () => {
		it("throws when the file has no default export", async () => {
			const project = setup({
				"/src/util.ts": "export const a = 1;\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/util.ts",
				}),
			).rejects.toThrow(/No default export/);
		});

		it("throws when the file is not found", async () => {
			const project = setup({ "/src/a.ts": "export const a = 1;\n" });

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/missing.ts",
				}),
			).rejects.toThrow(/File not found/);
		});

		it("throws when an anonymous default export has no newName", async () => {
			const project = setup({
				"/src/fn.ts": "export default () => 1;\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/fn.ts",
				}),
			).rejects.toThrow(/anonymous/);
		});

		it("throws when newName conflicts with an already-named default export", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/button.ts",
					newName: "Other",
				}),
			).rejects.toThrow(/already named/);
		});

		it("throws when newName is not a valid identifier", async () => {
			const project = setup({
				"/src/fn.ts": "export default () => 1;\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/fn.ts",
					newName: "not valid",
				}),
			).rejects.toThrow(/not a valid identifier/);
		});
	});
});
