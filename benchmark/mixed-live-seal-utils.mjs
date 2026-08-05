import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

export function digestDirectory(root, { excludePrefixes = [] } = {}) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path).split("\\").join("/");
      if (excludePrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) continue;
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) entries.push([relativePath, sha256(readFileSync(path))]);
      else throw new Error("runtime closure contains a non-regular entry");
    }
  };
  visit(root);
  return { fileCount: entries.length, manifestSha256: sha256(Buffer.from(JSON.stringify(entries))) };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
