// Slice 2 sub-A — DANGEROUS_COMMANDS regex set (D01).
//
// 출처: OWASP Top 10 2021 A03 Injection + CWE-78 (Improper Neutralization
// of Special Elements used in an OS Command). cleanroom-cc 코드 라인 직접
// 인용 0건 (matrix F09 / B22 준수). 패턴은 자체 작성 + RFC/SDK 표준 참조.
//
// Goal: Pre-execution filter for bash skill. Blocks shell commands that
// match common destructive / privilege-escalation / arbitrary-execution
// patterns. Returns the matched pattern's reason for audit logging.
//
// Limitations (intentional):
// - Pattern matching is best-effort; assume defense-in-depth.
// - Caller MUST also use execFile + args[] (not exec + shell-string).
// - Caller MUST sandbox at OS level for high-tier tools (T2/T3).
//
// Slice 2 docs cross-reference: docs/security/dangerous-commands.md.

export interface DangerousMatch {
  pattern: RegExp;
  reason: string;
}

/**
 * Curated dangerous shell pattern catalog. Each entry blocks a known class
 * of attack. Add new patterns via PR + matrix ID + OWASP/CWE reference.
 */
export const DANGEROUS_PATTERNS: ReadonlyArray<DangerousMatch> = [
  {
    // rm -rf /  |  rm -rf ~  |  rm -rf --no-preserve-root
    pattern:
      /(?:^|[\s;&|])\s*rm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+|--recursive\s+|--force\s+)+(?:[/~]\s*$|[/~][\s/]|--no-preserve-root)/,
    reason: "rm -rf targeting filesystem root or home (CWE-78)",
  },
  {
    // fork bomb :(){ :|: & };:
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*[&;]\s*\}\s*;\s*:/,
    reason: "fork bomb pattern (CWE-400)",
  },
  {
    // dd of=/dev/sd* | hd* | nvme* | mmcblk* | disk*  → block device overwrite
    pattern:
      /(?:^|[\s;&|])\s*dd\s+[^\n]*\bof\s*=\s*\/dev\/(?:sd|hd|nvme|disk|mmcblk)/i,
    reason: "dd writing to block device (data destruction)",
  },
  {
    // mkfs.* — filesystem format
    pattern: /(?:^|[\s;&|])\s*mkfs(?:\.\w+)?\s+\/?/,
    reason: "mkfs filesystem format (irreversible)",
  },
  {
    // > /dev/sd*  redirect to disk device
    pattern: /(?:^|[\s;&|])\s*>\s*\/dev\/(?:sd|hd|nvme|disk|mmcblk)/,
    reason: "redirect output to block device",
  },
  {
    // sudo + dangerous cmd — privilege escalation chain
    pattern:
      /(?:^|[\s;&|])\s*sudo\s+(?!-[a-zA-Z]*[hVv])[^\n]*\b(?:rm\s+-[a-zA-Z]*[rRf]|mkfs|dd\s+[^\n]*if=|chmod\s+-?R?\s*0?7?77|chown\s+-?R)/i,
    reason: "sudo + destructive/permission-changing command",
  },
  {
    // chmod 777 root/home — broad permission change
    pattern: /(?:^|[\s;&|])\s*chmod\s+-?R?\s*0?7?77\s+(?:[/~]\s*$|[/~][\s/]|\.\.\/)/,
    reason: "chmod 777 on root/home/parent path",
  },
  {
    // curl ... | bash | sh — pipe network output to shell (RCE)
    pattern: /\b(?:curl|wget|fetch)\b[^\n|]+\|\s*(?:bash|sh|zsh|fish|ksh)\b/i,
    reason: "piped network download to shell (arbitrary code execution)",
  },
  {
    // nc ... -e /bin/sh — reverse shell pattern
    pattern: /\bnc(?:at)?\s+[^\n]*-e\s+\/(?:usr\/)?(?:bin\/)?(?:bash|sh|zsh)/i,
    reason: "netcat reverse shell pattern",
  },
  {
    // eval/exec with variable expansion — input injection
    pattern: /\b(?:eval|exec)\s+["']?\$[A-Za-z_]/,
    reason: "eval/exec with variable expansion (injection)",
  },
  {
    // :(){ :|:& };:  variant with > or & abuse — match deeper variants
    pattern: /:\(\)\s*\{[^}]*\|\s*[^}]*&[^}]*\}/,
    reason: "fork bomb variant",
  },
  {
    // /dev/null operations specifically targeting block devices
    pattern: /(?:^|[\s;&|])\s*cat\s+\/dev\/(?:zero|random|urandom)\s*>[^>]/,
    reason: "cat /dev/zero|random redirected (DoS)",
  },
];

export interface DangerousCheckResult {
  blocked: boolean;
  matches: DangerousMatch[];
}

/**
 * Test a shell command string against the catalog.
 * Returns all matched patterns (informative; caller should reject if blocked).
 */
export function checkDangerous(command: string): DangerousCheckResult {
  const matches: DangerousMatch[] = [];
  for (const m of DANGEROUS_PATTERNS) {
    if (m.pattern.test(command)) matches.push(m);
  }
  return { blocked: matches.length > 0, matches };
}

/**
 * Convenience: throw if the command is blocked.
 */
export function assertSafe(command: string): void {
  const r = checkDangerous(command);
  if (r.blocked) {
    const reasons = r.matches.map((m) => m.reason).join("; ");
    throw new DangerousCommandError(command, reasons, r.matches);
  }
}

export class DangerousCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly reasons: string,
    public readonly matches: DangerousMatch[],
  ) {
    // Do NOT include full command in message (may leak secrets in logs);
    // first 60 chars + reason summary only.
    const summary = command.length > 60 ? command.slice(0, 60) + "…" : command;
    super(`dangerous command blocked: ${summary} — ${reasons}`);
    this.name = "DangerousCommandError";
  }
}
