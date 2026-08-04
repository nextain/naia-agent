#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const rootArgument = process.argv[2];
if (!rootArgument) throw new Error("tree path is required");
const root = resolve(rootArgument);
const ignoreGit = process.argv.includes("--ignore-git");
const files = walk(root).filter((file) => !(ignoreGit
  && relative(root, file).split(/[\\/]/u).includes(".git")));
const hash = createHash("sha256");
for (const file of files) {
  hash.update(relative(root, file).replaceAll("\\", "/")); hash.update("\0");
  hash.update(readFileSync(file)); hash.update("\0");
}
writeFileSync(1, `sha256:${hash.digest("hex")}\n`);

function walk(path) {
  return readdirSync(path).sort().flatMap((name) => {
    const child = resolve(path, name);
    return statSync(child).isDirectory() ? walk(child) : [child];
  });
}
