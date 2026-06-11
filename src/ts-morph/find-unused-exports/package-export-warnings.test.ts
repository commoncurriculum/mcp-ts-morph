import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import { findUnusedExports } from "./find-unused-exports";
import { collectPackageExportWarnings } from "./package-export-warnings";

/**
 * 最小 monorepo fixture:
 *
 * /packages/lib-src   exports → ./src/index.ts (ソース直参照。cross-package 参照が解決できる)
 * /packages/lib-dist  exports → ./dist/*       (built dist 公開。cross-package 参照が解決できない)
 * /apps/consumer      両方を import して消費
 *
 * `@scope/lib-src` だけ paths alias で解決できるようにし、`@scope/lib-dist` は
 * 実際の monorepo と同様「スキャン対象ソースに解決されない」状態を再現する。
 */
function setupMonorepoFixture(): Project {
	const project = createInMemoryProject({
		pathAliases: {
			"@scope/lib-src": ["packages/lib-src/src/index.ts"],
		},
	});
	const fs = project.getFileSystem();

	fs.writeFileSync(
		"/packages/lib-src/package.json",
		JSON.stringify({
			name: "@scope/lib-src",
			exports: { ".": "./src/index.ts" },
		}),
	);
	fs.writeFileSync(
		"/packages/lib-dist/package.json",
		JSON.stringify({
			name: "@scope/lib-dist",
			exports: {
				".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
			},
		}),
	);
	fs.writeFileSync(
		"/apps/consumer/package.json",
		JSON.stringify({ name: "@scope/consumer" }),
	);

	project.createSourceFile(
		"/packages/lib-src/src/index.ts",
		[
			"export function fromSrc(): number { return 1; }",
			"export function srcOnlyDead(): number { return 0; }",
		].join("\n"),
	);
	project.createSourceFile(
		"/packages/lib-dist/src/index.ts",
		"export function foo(): number { return 2; }",
	);
	project.createSourceFile(
		"/apps/consumer/src/main.ts",
		[
			'import { fromSrc } from "@scope/lib-src";',
			'import { foo } from "@scope/lib-dist";',
			"console.log(fromSrc(), foo());",
		].join("\n"),
	);
	return project;
}

describe("packageWarnings (built dist 公開パッケージの構造的警告)", () => {
	it("dist を exports で公開するパッケージ: 消費済み export が候補に出て (false positive 再現)、パッケージ警告が付く", () => {
		const project = setupMonorepoFixture();
		const result = findUnusedExports(project);

		// false positive の再現: foo は consumer から消費されているが候補に出る
		const fooEntry = result.unusedExports.find((e) => e.name === "foo");
		expect(fooEntry).toBeDefined();
		expect(fooEntry?.filePath).toBe("/packages/lib-dist/src/index.ts");
		// consumer 側の import がテキストには現れている (= textHits シグナル)
		expect(fooEntry?.textOccurrences).toBeGreaterThanOrEqual(1);

		// 構造的警告: lib-dist のみ
		expect(result.packageWarnings).toEqual([
			{
				packageJsonPath: "/packages/lib-dist/package.json",
				packageName: "@scope/lib-dist",
				externalEntryTargets: ["./dist/index.d.ts", "./dist/index.js"],
				candidateCount: 1,
			},
		]);
	});

	it("exports がソースを直接指すパッケージ: 参照が解決され、真の未使用候補が出ても警告は付かない", () => {
		const project = setupMonorepoFixture();
		const result = findUnusedExports(project);

		// fromSrc は cross-package 参照が解決されるので候補に出ない
		expect(result.unusedExports.map((e) => e.name)).not.toContain("fromSrc");
		// srcOnlyDead は真の未使用として候補に出る
		expect(result.unusedExports.map((e) => e.name)).toContain("srcOnlyDead");
		// それでも lib-src に警告は付かない (exports がスキャン対象ソースに解決できるため)
		expect(result.packageWarnings.map((w) => w.packageName)).not.toContain(
			"@scope/lib-src",
		);
	});

	it("単一パッケージのプロジェクトでは exports が dist を指していても警告しない (cross-package 参照が存在しない)", () => {
		const project = createInMemoryProject();
		const fs = project.getFileSystem();
		fs.writeFileSync(
			"/package.json",
			JSON.stringify({ name: "single", exports: { ".": "./dist/index.js" } }),
		);
		project.createSourceFile(
			"/src/index.ts",
			"export function unused(): void {}",
		);
		project.createSourceFile("/src/other.ts", "export const used = 1;");
		project.createSourceFile(
			"/src/main.ts",
			'import { used } from "./other";\nconsole.log(used);',
		);

		const result = findUnusedExports(project);
		expect(result.unusedExports.map((e) => e.name)).toContain("unused");
		expect(result.packageWarnings).toEqual([]);
	});

	it("package.json がどこにも無いプロジェクトでは警告しない", () => {
		const project = createInMemoryProject();
		project.createSourceFile("/a.ts", "export function unused(): void {}");
		project.createSourceFile("/b.ts", "const x = 1;");

		const result = findUnusedExports(project);
		expect(result.packageWarnings).toEqual([]);
	});

	describe("collectPackageExportWarnings (単体)", () => {
		function setupTwoPackages(libDistManifest: string): Project {
			const project = createInMemoryProject();
			const fs = project.getFileSystem();
			fs.writeFileSync("/packages/lib-dist/package.json", libDistManifest);
			fs.writeFileSync(
				"/apps/consumer/package.json",
				JSON.stringify({ name: "@scope/consumer" }),
			);
			project.createSourceFile(
				"/packages/lib-dist/src/index.ts",
				"export function foo(): number { return 2; }",
			);
			project.createSourceFile("/apps/consumer/src/main.ts", "const x = 1;");
			return project;
		}

		const scanned = [
			"/packages/lib-dist/src/index.ts",
			"/apps/consumer/src/main.ts",
		];
		const candidates = ["/packages/lib-dist/src/index.ts"];

		it("候補が 1 件も無いパッケージには警告しない", () => {
			const project = setupTwoPackages(
				JSON.stringify({
					name: "@scope/lib-dist",
					exports: { ".": "./dist/index.js" },
				}),
			);
			expect(collectPackageExportWarnings(project, scanned, [])).toEqual([]);
		});

		it("exports が無くても main が dist を指していれば警告する", () => {
			const project = setupTwoPackages(
				JSON.stringify({ name: "@scope/lib-dist", main: "dist/index.js" }),
			);
			const warnings = collectPackageExportWarnings(
				project,
				scanned,
				candidates,
			);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatchObject({
				packageName: "@scope/lib-dist",
				externalEntryTargets: ["dist/index.js"],
				candidateCount: 1,
			});
		});

		it("subpath パターン (`./*` → `./dist/*.js`) も dist 公開として警告する", () => {
			const project = setupTwoPackages(
				JSON.stringify({
					name: "@scope/lib-dist",
					exports: { "./*": "./dist/*.js" },
				}),
			);
			const warnings = collectPackageExportWarnings(
				project,
				scanned,
				candidates,
			);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.externalEntryTargets).toEqual(["./dist/*.js"]);
		});

		it("subpath パターンがスキャン対象ソース配下 (`./src/*`) を指す場合は警告しない", () => {
			const project = setupTwoPackages(
				JSON.stringify({
					name: "@scope/lib-dist",
					exports: { "./*": "./src/*" },
				}),
			);
			expect(
				collectPackageExportWarnings(project, scanned, candidates),
			).toEqual([]);
		});

		it("exports の条件分岐に 1 つでもソース解決可能な leaf があっても、dist leaf があれば警告する", () => {
			const project = setupTwoPackages(
				JSON.stringify({
					name: "@scope/lib-dist",
					exports: {
						".": { source: "./src/index.ts", default: "./dist/index.js" },
					},
				}),
			);
			const warnings = collectPackageExportWarnings(
				project,
				scanned,
				candidates,
			);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.externalEntryTargets).toEqual(["./dist/index.js"]);
		});

		it("コード以外のエントリ (`./package.json` 等) は無視する", () => {
			const project = setupTwoPackages(
				JSON.stringify({
					name: "@scope/lib-dist",
					exports: {
						".": "./src/index.ts",
						"./package.json": "./package.json",
					},
				}),
			);
			expect(
				collectPackageExportWarnings(project, scanned, candidates),
			).toEqual([]);
		});

		it("package.json が JSON として不正でもクラッシュせず警告なしで続行する", () => {
			const project = setupTwoPackages("{ this is not json");
			expect(
				collectPackageExportWarnings(project, scanned, candidates),
			).toEqual([]);
		});

		it("name の無い package.json は packageName が undefined になる", () => {
			const project = setupTwoPackages(
				JSON.stringify({ exports: { ".": "./dist/index.js" } }),
			);
			const warnings = collectPackageExportWarnings(
				project,
				scanned,
				candidates,
			);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.packageName).toBeUndefined();
		});
	});
});
