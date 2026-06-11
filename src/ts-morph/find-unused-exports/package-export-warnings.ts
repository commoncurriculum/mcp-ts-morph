import type { FileSystemHost, Project } from "ts-morph";
import logger from "../../utils/logger";

export interface PackageExportWarning {
	/** 警告対象パッケージの package.json の絶対パス */
	packageJsonPath: string;
	/** package.json の `name` (無名パッケージは undefined) */
	packageName: string | undefined;
	/**
	 * package.json のエントリポイント (`exports` / `main` / `module` / `types`) のうち、
	 * スキャン対象ソースに解決できなかった相対パス (例: `./dist/index.js`)。
	 */
	externalEntryTargets: string[];
	/** このパッケージ配下で報告された unused export 候補の数 */
	candidateCount: number;
}

/**
 * 「built dist を公開しているパッケージ」由来の系統的 false positive を構造的に検出する。
 *
 * monorepo で、あるパッケージの package.json エントリポイント (`exports` / `main` /
 * `module` / `types`) がスキャン対象ソース外 (例: `./dist/index.js`) を指す場合、
 * 他パッケージからの import はビルド成果物 (または node_modules) 側に解決され、
 * src 側のシンボルへの参照として観測できない。その結果、実際には消費されている
 * export がそのパッケージだけ一括で未使用候補になる。
 *
 * この関数は次の条件をすべて満たすパッケージごとに警告を 1 件返す:
 * 1. スキャン対象ファイルが 2 つ以上のパッケージ (package.json) にまたがっている
 *    (単一パッケージでは cross-package 参照自体が存在せず、この形の偽陽性は起きない)
 * 2. そのパッケージ配下に unused export 候補が 1 件以上ある
 * 3. package.json のエントリポイントのうち、解析対象のソースファイルに解決できない
 *    ものが 1 つ以上ある (`./dist/index.js` → `./dist/index.ts` 等の拡張子読み替えを
 *    試した上で、project 内の非宣言ファイルに到達できないもの)
 *
 * package.json の探索は各ソースファイルから上方向に最も近いものを採用する。
 * 読み取り失敗・JSON 不正は警告なしとして無視する (検出はベストエフォート)。
 */
export function collectPackageExportWarnings(
	project: Project,
	scannedFilePaths: string[],
	candidateFilePaths: string[],
): PackageExportWarning[] {
	const fs = project.getFileSystem();
	const dirToPackageJson = new Map<string, string | undefined>();

	const packageOf = (filePath: string): string | undefined =>
		findOwningPackageJson(dirnameOf(filePath), fs, dirToPackageJson);

	// 条件 1: スキャン対象が複数パッケージにまたがるか
	const scannedPackages = new Set<string>();
	for (const filePath of scannedFilePaths) {
		const pkg = packageOf(filePath);
		if (pkg) scannedPackages.add(pkg);
	}
	if (scannedPackages.size < 2) return [];

	// 条件 2: パッケージごとの候補数
	const candidateCountByPackage = new Map<string, number>();
	for (const filePath of candidateFilePaths) {
		const pkg = packageOf(filePath);
		if (!pkg) continue;
		candidateCountByPackage.set(
			pkg,
			(candidateCountByPackage.get(pkg) ?? 0) + 1,
		);
	}

	// 条件 3 の判定に使う「解析対象として見えているソース」の集合。
	// 宣言ファイル (.d.ts) は参照解決先になっても src のシンボルと別物なので含めない。
	const visibleSourcePaths = new Set<string>();
	for (const sf of project.getSourceFiles()) {
		if (sf.isInNodeModules()) continue;
		if (sf.isDeclarationFile()) continue;
		visibleSourcePaths.add(sf.getFilePath() as string);
	}

	const warnings: PackageExportWarning[] = [];
	for (const [packageJsonPath, candidateCount] of candidateCountByPackage) {
		const manifest = readManifest(packageJsonPath, fs);
		if (!manifest) continue;

		const packageDir = dirnameOf(packageJsonPath);
		const externalEntryTargets = collectEntryTargets(manifest).filter(
			(target) =>
				!resolvesToVisibleSource(target, packageDir, visibleSourcePaths),
		);
		if (externalEntryTargets.length === 0) continue;

		warnings.push({
			packageJsonPath,
			packageName:
				typeof manifest.name === "string" ? manifest.name : undefined,
			externalEntryTargets: [...new Set(externalEntryTargets)].sort(),
			candidateCount,
		});
	}

	return warnings.sort((a, b) =>
		a.packageJsonPath.localeCompare(b.packageJsonPath),
	);
}

function dirnameOf(filePath: string): string {
	const idx = filePath.lastIndexOf("/");
	return idx <= 0 ? "/" : filePath.slice(0, idx);
}

/**
 * dir から上方向に最も近い package.json を探す (結果は dir 単位でキャッシュ)。
 */
function findOwningPackageJson(
	dir: string,
	fs: FileSystemHost,
	cache: Map<string, string | undefined>,
): string | undefined {
	const visited: string[] = [];
	let current = dir;
	let found: string | undefined;

	while (true) {
		if (cache.has(current)) {
			found = cache.get(current);
			break;
		}
		visited.push(current);
		const candidate =
			current === "/" ? "/package.json" : `${current}/package.json`;
		let exists = false;
		try {
			exists = fs.fileExistsSync(candidate);
		} catch {
			// 読めないディレクトリはベストエフォートで無視
		}
		if (exists) {
			found = candidate;
			break;
		}
		const parent = dirnameOf(current);
		if (parent === current) break;
		current = parent;
	}

	for (const v of visited) cache.set(v, found);
	return found;
}

interface PackageManifest {
	name?: unknown;
	exports?: unknown;
	main?: unknown;
	module?: unknown;
	types?: unknown;
}

function readManifest(
	packageJsonPath: string,
	fs: FileSystemHost,
): PackageManifest | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as PackageManifest;
	} catch (error) {
		logger.debug(
			{ err: error, packageJsonPath },
			"package.json の読み取りに失敗したためパッケージ警告の判定をスキップします",
		);
		return undefined;
	}
}

/** JS/TS のコードを指していそうなパスだけをエントリポイントとして扱う (`./package.json` 等は除外)。 */
const CODE_TARGET_RE = /\.[mc]?[jt]sx?$/;

/**
 * package.json から、外部 consumer のモジュール解決先になり得る相対パスを列挙する。
 * `exports` は conditions / subpaths でネストするため、文字列 leaf を再帰的に集める。
 */
function collectEntryTargets(manifest: PackageManifest): string[] {
	const targets: string[] = [];

	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			if (CODE_TARGET_RE.test(value) || value.includes("*")) {
				targets.push(value);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value === "object" && value !== null) {
			for (const item of Object.values(value)) visit(item);
		}
	};

	visit(manifest.exports);
	for (const field of [manifest.main, manifest.module, manifest.types]) {
		if (typeof field === "string" && CODE_TARGET_RE.test(field)) {
			targets.push(field);
		}
	}
	return targets;
}

/**
 * エントリポイント相対パスが、解析対象として見えているソースファイルに解決できるか。
 *
 * - ビルド出力を指すパス (`./dist/index.js` 等) はソースとの拡張子読み替え
 *   (`.js` → `.ts`/`.tsx`, `.d.ts` → `.ts` 等) を試した上で判定する。
 * - `*` を含む subpath パターンは個別解決できないため、`*` より前のプレフィックス配下に
 *   見えているソースが 1 つでもあれば「解決できる」とみなす。
 */
function resolvesToVisibleSource(
	target: string,
	packageDir: string,
	visibleSourcePaths: Set<string>,
): boolean {
	const normalized = target.replace(/^\.\//, "");

	const starIndex = normalized.indexOf("*");
	if (starIndex >= 0) {
		const prefix = `${packageDir}/${normalized.slice(0, starIndex)}`;
		for (const sourcePath of visibleSourcePaths) {
			if (sourcePath.startsWith(prefix)) return true;
		}
		return false;
	}

	const absolute = `${packageDir}/${normalized}`;
	for (const candidate of sourceCandidatesFor(absolute)) {
		if (visibleSourcePaths.has(candidate)) return true;
	}
	return false;
}

/** ビルド出力のパスから、対応し得るソースファイルパスの候補を列挙する。 */
function sourceCandidatesFor(absolutePath: string): string[] {
	const candidates = [absolutePath];
	if (absolutePath.endsWith(".d.ts")) {
		const base = absolutePath.slice(0, -".d.ts".length);
		candidates.push(`${base}.ts`, `${base}.tsx`);
	} else if (absolutePath.endsWith(".d.mts")) {
		candidates.push(`${absolutePath.slice(0, -".d.mts".length)}.mts`);
	} else if (absolutePath.endsWith(".d.cts")) {
		candidates.push(`${absolutePath.slice(0, -".d.cts".length)}.cts`);
	} else if (absolutePath.endsWith(".js")) {
		const base = absolutePath.slice(0, -".js".length);
		candidates.push(`${base}.ts`, `${base}.tsx`);
	} else if (absolutePath.endsWith(".mjs")) {
		candidates.push(`${absolutePath.slice(0, -".mjs".length)}.mts`);
	} else if (absolutePath.endsWith(".cjs")) {
		candidates.push(`${absolutePath.slice(0, -".cjs".length)}.cts`);
	} else if (absolutePath.endsWith(".jsx")) {
		candidates.push(`${absolutePath.slice(0, -".jsx".length)}.tsx`);
	}
	return candidates;
}
