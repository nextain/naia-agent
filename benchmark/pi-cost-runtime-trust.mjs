import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

export function collectTrustedRuntimeFiles(root, roots) {
  const pending = [...roots]; const visited = new Set(); const files = {};
  while (pending.length > 0) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    if (name.startsWith("../") || name.startsWith("/")) throw new Error(`trusted runtime path escapes closure: ${name}`);
    const path = join(root, name);
    if (!existsSync(path)) throw new Error(`trusted runtime module missing: ${name}`);
    visited.add(name); files[name] = path;
    const source = ts.createSourceFile(name, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(path), specifier);
      const candidates = [target, `${target}.js`, join(target, "index.js")];
      const resolved = candidates.find(isFile);
      if (!resolved) throw new Error(`unresolved trusted runtime import from ${name}: ${specifier}`);
      const child = relative(root, resolved).replaceAll("\\", "/");
      if (child.startsWith("../") || child === "..") throw new Error(`trusted runtime import escapes dist root: ${specifier}`);
      pending.push(child);
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

export function collectTrustedPackageFiles(repositoryRoot, packages) {
  const allowedPackages = new Set(packages.map((entry) => entry.name));
  const output = {}; const packageRoots = new Map();
  for (const entry of packages) {
    const parentRoot = entry.resolveFrom ? packageRoots.get(entry.resolveFrom) : undefined;
    if (entry.resolveFrom && !parentRoot) throw new Error(`trusted package parent unavailable: ${entry.resolveFrom}`);
    const packageRoot = resolvePackageRoot(repositoryRoot, entry.name, parentRoot);
    packageRoots.set(entry.name, packageRoot);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== entry.name || manifest.version !== entry.version) {
      throw new Error(`trusted package identity mismatch: ${entry.name}@${entry.version}`);
    }
    output[`npm:${entry.name}/package.json`] = join(packageRoot, "package.json");
    const closure = collectPackageClosure(packageRoot, entry.modules);
    for (const [name, path] of Object.entries(closure.files)) output[`npm:${entry.name}/${name}`] = path;
    for (const specifier of closure.bareImports) {
      const dependency = packageName(specifier);
      if (!isBuiltin(specifier) && !allowedPackages.has(dependency)) {
        throw new Error(`untrusted package import from ${entry.name}: ${specifier}`);
      }
    }
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

export function collectTrustedExecutableFiles(entryPath) {
  const files = collectExecutableClosure(realpathSync(entryPath));
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("trusted executable closure is malformed");
  return files;
}

export function captureTrustedRuntimeDigests(files) {
  return Object.fromEntries(Object.entries(files).map(([name, path]) => [name, digestFile(path)]));
}

export function assertTrustedRuntimeUnchanged(files, expected) {
  for (const [name, path] of Object.entries(files)) {
    if (digestFile(path) !== expected[name]) throw new Error(`trusted benchmark runtime changed after preload: ${name}`);
  }
}

export function assertTrustedRuntimeFileSetUnchanged(expected, actual) {
  const expectedNames = Object.keys(expected).sort(); const actualNames = Object.keys(actual).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    throw new Error("trusted benchmark runtime file set changed after preload");
  }
  for (const name of expectedNames) {
    if (realpathSync(expected[name]) !== realpathSync(actual[name])) {
      throw new Error(`trusted benchmark runtime path changed after preload: ${name}`);
    }
  }
}

export function trustedRuntimeManifestDigest(digests) {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(digests)
    .sort(([left], [right]) => left.localeCompare(right))));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function digestFile(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function moduleSpecifiers(source, rejectComputed = true) {
  return moduleEdges(source, rejectComputed, rejectComputed).map((edge) => edge.specifier);
}

function moduleEdges(source, rejectComputedImport = true, rejectComputedRequire = rejectComputedImport) {
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push({ specifier: node.moduleSpecifier.text, mode: "import", optional: false });
    }
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteralLike(argument)) {
        if (rejectComputedImport) throw new Error(`computed dynamic import in trusted runtime: ${source.fileName}`);
        return;
      }
      specifiers.push({ specifier: argument.text, mode: "import", optional: isInsideTry(node) });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "require") {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) {
        specifiers.push({ specifier: argument.text, mode: "require", optional: isInsideTry(node) });
      }
      else if (rejectComputedRequire) throw new Error(`computed require in trusted runtime: ${source.fileName}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return specifiers;
}

function isInsideTry(node) {
  let current = node.parent;
  while (current) {
    if (ts.isTryStatement(current)) return true;
    current = current.parent;
  }
  return false;
}

function collectPackageClosure(root, roots) {
  const pending = [...roots]; const visited = new Set(); const files = {}; const bareImports = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    if (name.startsWith("../") || name.startsWith("/")) throw new Error(`trusted package path escapes closure: ${name}`);
    const path = join(root, name);
    if (!existsSync(path)) throw new Error(`trusted package module missing: ${name}`);
    visited.add(name); files[name] = path;
    const source = ts.createSourceFile(name, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
      name.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.JS);
    for (const specifier of moduleSpecifiers(source, false)) {
      if (!specifier.startsWith(".")) { bareImports.add(specifier); continue; }
      const target = resolve(dirname(path), specifier);
      const candidates = [target, `${target}.js`, `${target}.mjs`, join(target, "index.js"), join(target, "index.mjs")];
      const resolved = candidates.find(isFile);
      if (!resolved) throw new Error(`unresolved trusted package import from ${name}: ${specifier}`);
      const child = relative(root, resolved).replaceAll("\\", "/");
      if (child.startsWith("../") || child === "..") throw new Error(`trusted package import escapes package root: ${specifier}`);
      pending.push(child);
    }
  }
  return { files, bareImports };
}

function resolvePackageRoot(repositoryRoot, name, parentRoot) {
  const dependencyRoot = parentRoot ? nearestNodeModules(realpathSync(parentRoot)) : undefined;
  const candidates = [
    ...(dependencyRoot ? [join(dependencyRoot, ...name.split("/"))] : []),
    join(repositoryRoot, "node_modules", ...name.split("/")),
    join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", ...name.split("/")),
    join(repositoryRoot, "node_modules", ".pnpm", "node_modules", ...name.split("/")),
  ];
  const root = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
  if (!root) throw new Error(`trusted package unavailable: ${name}`);
  return root;
}

function nearestNodeModules(path) {
  let current = dirname(path);
  while (dirname(current) !== current) {
    if (basename(current) === "node_modules") return current;
    current = dirname(current);
  }
  throw new Error(`trusted package is not installed beneath node_modules: ${path}`);
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function isBuiltin(specifier) {
  const name = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return builtinModules.includes(name) || builtinModules.includes(`node:${name}`);
}

function collectExecutableClosure(entryPath) {
  const pending = [realpathSync(entryPath)]; const visited = new Set(); const files = {};
  while (pending.length > 0) {
    const path = realpathSync(pending.pop());
    if (visited.has(path)) continue;
    visited.add(path);
    const identity = packageFileIdentity(path);
    if (files[identity] && realpathSync(files[identity]) !== path) throw new Error(`trusted executable identity collision: ${identity}`);
    files[identity] = path;
    if (!/\.[cm]?js$/u.test(path)) continue;
    const sourceText = readFileSync(path, "utf8");
    const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const computedTargets = approvedComputedImportTargets(path, sourceText);
    const edges = moduleEdges(source, computedTargets === undefined, true);
    edges.push(...(computedTargets ?? []).map((specifier) => ({ specifier, mode: "import", optional: false })));
    for (const { specifier, mode, optional } of edges) {
      if (isBuiltin(specifier)) continue;
      let target;
      if (specifier.startsWith(".")) {
        const base = resolve(dirname(path), specifier);
        target = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, "index.js"), join(base, "index.mjs")]
          .find(isFile);
        if (!target) throw new Error(`unresolved executable import from ${path}: ${specifier}`);
      } else if (specifier.startsWith("#")) {
        target = resolveInternalPackageImport(specifier, path, mode);
      } else {
        try { target = resolvePackageImport(specifier, path, mode); }
        catch (error) {
          if (optional && error instanceof Error && error.message.startsWith("unresolved executable package import")) continue;
          throw error;
        }
      }
      pending.push(target);
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

function resolveInternalPackageImport(specifier, parentPath, mode) {
  let current = dirname(parentPath);
  while (dirname(current) !== current) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const target = resolveExportTarget(manifest.imports, specifier, mode);
      if (typeof target !== "string") throw new Error(`package import unavailable from ${parentPath}: ${specifier}`);
      if (target.startsWith(".")) {
        const resolved = resolve(current, target);
        if (!existsSync(resolved)) throw new Error(`package import target missing from ${parentPath}: ${specifier}`);
        return resolved;
      }
      return resolvePackageImport(target, parentPath, mode);
    }
    current = dirname(current);
  }
  throw new Error(`package import has no enclosing package from ${parentPath}: ${specifier}`);
}

function resolvePackageImport(specifier, parentPath, mode = "import") {
  const name = packageName(specifier);
  const rest = specifier.slice(name.length).replace(/^\//u, "");
  let current = dirname(parentPath); let packageRoot;
  while (dirname(current) !== current) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) { packageRoot = realpathSync(candidate); break; }
    current = dirname(current);
  }
  if (!packageRoot) throw new Error(`unresolved executable package import from ${parentPath}: ${specifier}`);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const subpath = rest ? `./${rest}` : ".";
  const exported = resolveExportTarget(manifest.exports, subpath, mode);
  const legacyTarget = manifest.exports === undefined
    ? (rest || (typeof manifest.main === "string" ? manifest.main : "index.js")) : undefined;
  const target = exported ?? legacyTarget;
  if (typeof target !== "string") throw new Error(`package export unavailable from ${parentPath}: ${specifier}`);
  const base = resolve(packageRoot, target);
  const resolved = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, "index.js"), join(base, "index.cjs")]
    .find(isFile);
  if (!resolved) throw new Error(`package export target missing from ${parentPath}: ${specifier} -> ${base}`);
  return resolved;
}

function resolveExportTarget(exports, subpath, mode = "import") {
  if (typeof exports === "string") return subpath === "." ? exports : undefined;
  if (Array.isArray(exports)) {
    for (const entry of exports) { const target = resolveExportTarget(entry, subpath, mode); if (target) return target; }
    return undefined;
  }
  if (!exports || typeof exports !== "object") return undefined;
  const keys = Object.keys(exports);
  if (keys.some((key) => key.startsWith(".") || key.startsWith("#"))) {
    if (Object.hasOwn(exports, subpath)) return selectImportCondition(exports[subpath], mode);
    for (const key of keys.filter((candidate) => candidate.includes("*"))) {
      const [prefix, suffix] = key.split("*");
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
        const wildcard = subpath.slice(prefix.length, subpath.length - suffix.length);
        const target = selectImportCondition(exports[key], mode);
        if (typeof target === "string") return target.replaceAll("*", wildcard);
      }
    }
    return undefined;
  }
  return selectImportCondition(exports, mode);
}

function selectImportCondition(value, mode = "import") {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) { const target = selectImportCondition(entry, mode); if (target) return target; }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const condition of [mode, "node", "default"]) {
    if (Object.hasOwn(value, condition)) { const target = selectImportCondition(value[condition], mode); if (target) return target; }
  }
  return undefined;
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function approvedComputedImportTargets(path, source) {
  const normalized = path.replaceAll("\\", "/");
  const dynamicImports = [...source.matchAll(/\bimport\s*\(/gu)];
  if (normalized.endsWith("/@earendil-works/pi-ai/dist/auth/context.js")) {
    const calls = [...source.matchAll(/importNodeModule\("([^"]+)"\)/gu)].map((match) => match[1]);
    return calls.length > 0 && dynamicImports.length === 1 && calls.every((specifier) => isBuiltin(specifier)) ? [] : undefined;
  }
  if (normalized.endsWith("/@earendil-works/pi-ai/dist/auth/oauth/load.js")) {
    const calls = [...source.matchAll(/importOAuthModule\("([^"\n]+)"\)/gu)]
      .map((match) => match[1].replace(/\.ts$/u, ".js"));
    return calls.length > 0 && dynamicImports.length === 1 && calls.every((specifier) => specifier.startsWith("./"))
      ? calls : undefined;
  }
  if (normalized.endsWith("/@earendil-works/pi-ai/dist/env-api-keys.js")) {
    const declarations = [...source.matchAll(/const NODE_([A-Z]+)_SPECIFIER = "node:" \+ "([^"]+)";/gu)]
      .map((match) => [match[1], `node:${match[2]}`]);
    const calls = [...source.matchAll(/dynamicImport\(NODE_([A-Z]+)_SPECIFIER\)/gu)].map((match) => match[1]);
    const declaredNames = declarations.map(([name]) => name).sort();
    const declaredTargets = declarations.map(([, target]) => target).sort();
    return dynamicImports.length === 1
      && JSON.stringify(declaredNames) === JSON.stringify(["FS", "OS", "PATH"])
      && JSON.stringify(declaredTargets) === JSON.stringify(["node:fs", "node:os", "node:path"])
      && JSON.stringify([...new Set(calls)].sort()) === JSON.stringify(["FS", "OS", "PATH"])
      && calls.every((name) => declaredNames.includes(name)) ? [] : undefined;
  }
  if (normalized.endsWith("/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.lazy.js")) {
    const calls = [...source.matchAll(/importNodeOnlyApi\("([^"\n]+)"\)/gu)]
      .map((match) => match[1].replace(/\.ts$/u, ".js"));
    return dynamicImports.length === 1
      && JSON.stringify(calls) === JSON.stringify(["./bedrock-converse-stream.js"]) ? calls : undefined;
  }
  if (normalized.endsWith("/jiti/lib/jiti-static.mjs")) {
    // Pi uses jiti only to load the explicitly supplied benchmark extension;
    // that extension and its helper are separate trustedRuntimeArtifacts.
    return dynamicImports.length === 1 && source.includes("const nativeImport = (id) => import(id);") ? [] : undefined;
  }
  return undefined;
}

function packageFileIdentity(path) {
  let current = dirname(path);
  while (dirname(current) !== current) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (typeof manifest.name === "string" && typeof manifest.version === "string") {
          return `npm-exec:${manifest.name}@${manifest.version}/${relative(current, path).replaceAll("\\", "/")}`;
        }
      } catch { /* keep walking to an enclosing valid package */ }
    }
    current = dirname(current);
  }
  throw new Error(`trusted executable file has no package identity: ${path}`);
}
