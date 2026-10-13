// What a shell command is about to do, in words, for Claude Code's permission
// dialog on Bash and PowerShell. Rule-based and offline: it splits the command
// into steps, says what each program it knows does, flags the parts worth a
// second look, and rates the whole command with a banner on top. A program it
// doesn't know is named, not guessed at.
//
// Pure JavaScript with no imports, so it runs inside a mod (no Node there) as well
// as under Node. What it can't know by itself comes in through options:
//   exists(path)  whether an absolute path exists, for "overwrites X" vs "a new file"
//   read(path)    an absolute path's text, or null when it can't be read, so what a
//                 script about to run holds is rated too: package.json's scripts,
//                 ./deploy.sh, python seed.py
//   homedir       to tell whether a ~ path is inside the project
//   why           why Claude Code asked, in a sentence, when the caller knows it

const MAX_STEPS = 8;
// How much of a file is read, and how many scripts deep (a script that runs a script).
const MAX_READ = 200_000;
const MAX_SOURCES = 3;

// Risk levels, lowest first. A command gets the highest level any part of it reaches.
const SAFE = 0;
const LOW = 1;
const ATTENTION = 2;
const HIGH = 3;
const LEVELS = [
  { id: "safe", banner: "🟢 SAFE", summary: "only reads; nothing is changed" },
  { id: "low", banner: "🔵 LOW RISK", summary: "makes ordinary changes inside this project" },
  { id: "attention", banner: "🟡 NEEDS YOUR ATTENTION" },
  { id: "high", banner: "🔴 HIGH RISK" },
];
const MARKS = ["", "·", "!", "!!"];

// How a step follows the one before it.
const JOINERS = {
  "&&": "then, if that worked: ",
  "||": "if that failed: ",
  "|": "its output goes to: ",
  ";": "then: ",
  "&": "alongside: ",
};

// Why Claude Code asked, by permission mode.
const MODES = {
  default: "nothing in your allow rules covers this command",
  acceptEdits: "accept-edits mode approves file edits, not shell commands",
  plan: "plan mode asks before running commands",
  auto: "auto mode didn't approve this one on its own",
};

// Where "don't ask again" saves a rule (a permission suggestion's destination).
const WHERE = {
  localSettings: "for this project",
  projectSettings: "for this project, for everyone on it",
  userSettings: "for every project",
  session: "for the rest of this session",
  cliArg: "for the rest of this session",
};

const NULLS = /^(\/dev\/null|\$null|nul)$/i;
const FETCHERS = new Set(["curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm"]);
const SHELL_RUNNERS = new Set(["sh", "bash", "zsh", "iex", "invoke-expression", "powershell", "pwsh"]);

// input: the tool call as a hook sees it ({ tool_name, tool_input, cwd, ... }).
// Returns null for other tools.
export function explainPermission(input, options) {
  return assessPermission(input, options)?.text ?? null;
}

// { level, reason, banner, risks: [{ level, text }], text }, or null for other tools.
// level is "safe" | "low" | "attention" | "high"; banner is the one line on top;
// text is the whole explanation; the rest is the same rating as data.
export function assessPermission(input, options = {}) {
  const shell = input?.tool_name;
  if (shell !== "Bash" && shell !== "PowerShell") return null;
  const ti = input.tool_input || {};
  if (typeof ti.command !== "string" || !ti.command.trim()) return null;

  const cwd = typeof input.cwd === "string" ? input.cwd : null;
  const ctx = {
    ps: shell === "PowerShell",
    cwd,
    windows: /^[A-Za-z]:[\\/]/.test(cwd ?? ""),
    homedir: options.homedir ?? null,
    existsFn: options.exists ?? null,
    readFn: options.read ?? null,
    level: SAFE,
    risks: new Map(),
    outside: new Set(),
    nested: false,
    heredoc: false,
    // While a script's contents are rated: its name, which goes in front of each
    // risk found in it, the programs in it this explainer doesn't know, and the
    // package.json folder when it's a package script.
    source: null,
    unknown: null,
    pkgDir: null,
    sources: new Set(),
    // The folder relative paths resolve from: the session's, until a cd in the
    // command changes it. null when it can't be told (cd $DIR, cd -).
    here: cwd,
    dirs: [],
  };
  ctx.raise = (n) => (ctx.level = Math.max(ctx.level, n));
  ctx.risk = (text, n = ATTENTION) => {
    const key = ctx.source ? `${ctx.source}: ${text}` : text;
    ctx.risks.set(key, Math.max(ctx.risks.get(key) ?? SAFE, n));
    ctx.raise(n);
  };
  ctx.changes = () => ctx.raise(LOW);

  // Every step is rated, even the ones past MAX_STEPS that aren't listed.
  const steps = walk(ti.command, ctx);
  if (ctx.outside.size) ctx.risk(`reaches outside this project: ${list([...ctx.outside])}`);
  if (ti.dangerouslyDisableSandbox) ctx.risk("runs outside the sandbox");

  const risks = [...ctx.risks].sort((a, b) => b[1] - a[1]);
  const reason = reasonFor(ctx.level, risks);
  const banner = `${LEVELS[ctx.level].banner} — ${reason}`;
  const out = [banner];
  out.push(ti.description ? `${shell} is waiting for you. Claude says: "${ti.description}"` : `${shell} is waiting for you.`);
  out.push("What it does:");
  steps.slice(0, MAX_STEPS).forEach((line, n) => out.push(`  ${n + 1}. ${line}`));
  if (steps.length > MAX_STEPS) out.push(`  …and ${steps.length - MAX_STEPS} more steps`);

  const notes = [];
  if (ctx.nested) notes.push("parts in $(…) run first, and their output is pasted into the command");
  if (ctx.heredoc) notes.push("a block of text inside the command is fed to it as input");
  if (ti.run_in_background) notes.push("it runs in the background, and Claude is told when it ends");
  if (notes.length) out.push(`Also: ${notes.join("; ")}.`);

  if (risks.length) {
    out.push("Worth a look:");
    for (const [text, n] of risks) out.push(`  ${MARKS[n].padEnd(2)} ${text}`);
  }
  out.push(whyAsked(input, options.why));
  return {
    level: LEVELS[ctx.level].id,
    reason,
    banner,
    risks: risks.map(([text, n]) => ({ level: LEVELS[n].id, text })),
    text: out.join("\n"),
  };
}

// The words after the banner: the biggest reason for the level.
function reasonFor(level, risks) {
  if (level < ATTENTION) return LEVELS[level].summary;
  const serious = risks.filter(([, n]) => n >= ATTENTION).length;
  return `${risks[0][0]}${serious > 1 ? ` (+${serious - 1} more)` : ""}`;
}

// Steps in words, with the commands inside $(…) after them.
function walk(src, ctx, depth = 0) {
  const { steps, nested, heredoc } = parse(src, ctx.ps);
  if (heredoc) ctx.heredoc = true;
  const lines = [];
  let prev = null;
  steps.forEach((step) => {
    const described = describeStep(step, ctx);
    if (!described) return; // shell syntax only: fi, done, for x in …
    const { text, name } = described;
    if (step.joiner === "|" && SHELL_RUNNERS.has(name) && FETCHERS.has(prev)) {
      ctx.risk("runs a downloaded script straight away (piped into a shell)", HIGH);
    }
    const lead = lines.length ? JOINERS[step.joiner] ?? "then: " : depth ? "first, inside $(…): " : "";
    lines.push(lead + text);
    prev = name;
  });
  if (nested.length) ctx.nested = true;
  if (depth < 3) {
    for (const inner of nested) {
      // A cd inside $(…) runs in a subshell; it doesn't move the command.
      const here = ctx.here;
      lines.push(...walk(inner, ctx, depth + 1));
      ctx.here = here;
    }
  }
  return lines;
}

function whyAsked(input, why) {
  const reason =
    typeof why === "string" && why.trim()
      ? why.trim().replace(/\.$/, "")
      : input.tool_input?.dangerouslyDisableSandbox
        ? "running outside the sandbox always needs your OK"
        : MODES[input.permission_mode] ?? MODES.default;
  const save = describeSuggestions(input.permission_suggestions);
  return `Why it asked: ${reason}.${save ? ` "Don't ask again" would save ${save}.` : ""}`;
}

function describeSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) return null;
  const parts = [];
  for (const u of suggestions) {
    const where = WHERE[u?.destination] ?? "";
    if (u?.type === "addRules" && u.behavior === "allow" && Array.isArray(u.rules)) {
      const rules = u.rules.filter((r) => r?.toolName).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
      if (rules.length) parts.push(`${rules.join(", ")} ${where}`.trim());
    } else if (u?.type === "addDirectories" && Array.isArray(u.directories) && u.directories.length) {
      parts.push(`access to ${u.directories.join(", ")} ${where}`.trim());
    }
  }
  return parts.length ? parts.join("; ") : null;
}

// ---- One step ----

// { text, name }, or null for a step that's only shell syntax.
function describeStep(step, ctx) {
  let words = step.words.filter((w) => !["{", "}", "(", ")"].includes(w));
  if (words.length) {
    words = withoutSyntax(words, ctx);
    if (!words) return null;
  }
  const shown = short(words.join(" ") || step.redirects.map((r) => `${r.op} ${r.target}`).join(" "));
  const extras = [];

  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const name = words.shift().split("=")[0];
    if (!words.length) return { text: `${shown} — sets the variable ${name}`, name: null };
    extras.push(`with ${name} set`);
  }
  // Wrappers that run the next word as the command.
  while (words.length > 1) {
    const w = prog(words[0]);
    if (w === "sudo" || w === "doas") ctx.risk("runs with admin rights (sudo)", HIGH);
    else if (w === "timeout") words.shift();
    else if (!["env", "time", "nohup", "nice", "command", "exec"].includes(w)) break;
    words.shift();
  }

  let name = null;
  let what = "redirects input or output";
  if (words.length) {
    name = prog(words[0]);
    const args = words.slice(1);
    const fn = PROGRAMS[name];
    const script = !fn && SCRIPT_PATH.test(words[0]) ? runFile(words[0], null, ctx) : null;
    if (fn) {
      what = fn(args, ctx);
      if (!READS.has(name) && !SELF_RATED.has(name)) ctx.changes();
    } else if (script) {
      what = script;
    } else if (ctx.pkgDir !== null && projectTool(name, ctx)) {
      // A package script's own tools: jest, eslint, vite from node_modules/.bin.
      what = `runs ${name}, a tool installed in this project`;
      ctx.changes();
    } else if (ctx.unknown) {
      // Inside a script, the unknown ones are named together, once.
      what = `runs ${name}, which this explainer doesn't know`;
      ctx.unknown.add(name);
    } else {
      what = `runs ${name}, which this explainer doesn't know; check what it does`;
      ctx.risk(`runs ${name}, a program this explainer doesn't know`);
    }
    // cd checks its own target, from the folder it left (changeDir).
    const code = expressionArgs(name, args);
    if (fn !== changeDir && !CHANGES_DIR.has(name)) args.forEach((a, i) => code.has(i) || checkPath(a, ctx));
  }
  for (const r of step.redirects) extras.push(describeRedirect(r, ctx));
  return { text: `${shown} — ${what}${extras.length ? ` (${extras.join(", ")})` : ""}`, name };
}

// The words of a step without the shell's own syntax around the command: the
// "if", "then", "do" in front of it, a case pattern, a PowerShell condition or
// assignment. null when nothing is left to run (fi, done, for x in …, f() {).
const BASH_LEADS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!"]);
const BASH_ENDS = new Set(["fi", "done", "esac", "for", "select", "case", "function"]);
const PS_LEADS = new Set(["if", "elseif", "else", "foreach", "for", "while", "do", "until", "switch", "try", "catch", "finally", "begin", "process", "end"]);

function withoutSyntax(words, ctx) {
  const w = [...words];
  for (;;) {
    if (!w.length) return null;
    const k = w[0].toLowerCase();
    if (ctx.ps) {
      if (k === "function" || k === "filter" || k.startsWith("param(") || k === "param" || /^\[/.test(k)) return null;
      if (PS_LEADS.has(k)) {
        w.shift();
        // The condition in ( … ), which may be split into several words.
        if (w[0]?.startsWith("(")) {
          let depth = 0;
          do {
            const word = w.shift();
            depth += (word.match(/\(/g) ?? []).length - (word.match(/\)/g) ?? []).length;
          } while (w.length && depth > 0);
        }
        continue;
      }
      // $x = Get-Thing: the command is after the =. $x = "Stop" is only a value.
      if (k.startsWith("$") && (["=", "+=", "-="].includes(w[1]) || /^\$[\w:.]+=/.test(k))) {
        w.splice(0, ["=", "+=", "-="].includes(w[1]) ? 2 : 1);
        if (w.length && !PROGRAMS[prog(w[0])] && !/^[a-z]+-[a-z]/i.test(w[0])) return null;
        continue;
      }
      // Inside a script, a line that starts with a variable is an expression.
      if (k.startsWith("$") && ctx.unknown) return null;
      return w;
    }
    if (BASH_LEADS.has(k)) w.shift();
    else if (BASH_ENDS.has(k) || /^[\w-]+\(\)$/.test(k)) return null;
    else if (/^[^()]*\)$/.test(k)) w.shift(); // a case pattern: start)
    else return w;
  }
}

// Runs another command given as words (xargs rm, find -exec rm), so it's rated too.
function inner(words, ctx) {
  if (!words.length) return "a command";
  describeStep({ words, redirects: [], joiner: null }, ctx);
  return prog(words[0]);
}

function describeRedirect({ op, target }, ctx) {
  if (op === "<<" || op === "<<-") return "fed the text block that follows";
  if (op === "<<<") return "fed a line of text";
  if (op.endsWith("<")) return `reads input from ${target}`;
  const what = op.startsWith("2") ? "errors" : op.startsWith("&") ? "all output" : "output";
  if (NULLS.test(target)) return `${what} discarded`;
  checkPath(target, ctx);
  ctx.changes();
  if (op.endsWith(">>")) return `appends ${what} to ${target}`;
  if (!exists(target, ctx)) return `writes ${what} to a new file, ${target}`;
  ctx.risk(`overwrites ${target}`);
  return `writes ${what} to ${target}, replacing it`;
}

// ~ and Git Bash's /c/ spelling, as the path the file system knows.
function nativePath(word, ctx) {
  let p = word.startsWith("~") && ctx.homedir ? ctx.homedir + word.slice(1) : word;
  if (ctx.windows && /^\/[a-z]\//i.test(p)) p = `${p[1]}:${p.slice(2)}`;
  return p;
}

const isAbsolute = (p) => /^([A-Za-z]:)?[\\/]/.test(p);

// The absolute path a word names, relative ones taken from the folder the
// command is in by then. null for a relative one when that folder isn't known.
function resolvePath(word, ctx) {
  const p = nativePath(word, ctx).replace(/^(\.[\\/]+)+/, "");
  if (isAbsolute(p)) return normalize(p, ctx);
  if (!ctx.here) return null;
  return normalize(ctx.here.replace(/[\\/]+$/, "") + (ctx.windows ? "\\" : "/") + p, ctx);
}

// A path without its . and .. parts: C:\a\b\..\c is C:\a\c.
function normalize(p, ctx) {
  const sep = ctx.windows ? "\\" : "/";
  const root = /^([A-Za-z]:)?[\\/]?/.exec(p)[0].replace(/[\\/]/, sep);
  const parts = [];
  for (const part of p.slice(root.length).split(/[\\/]+/)) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return root + parts.join(sep);
}

const CHANGES_DIR = new Set(["cd", "chdir", "set-location", "sl", "pushd", "push-location", "popd", "pop-location"]);

// cd, pushd, Set-Location: later paths in the command resolve from there.
// A folder that can't be told ($DIR, -, ~ without a home) makes them unknown,
// so what's read there counts as unreadable, never as harmless.
function changeDir(args, ctx, { push = false, pop = false } = {}) {
  if (pop) {
    ctx.here = ctx.dirs.length ? ctx.dirs.pop() : null;
    return "goes back to the folder it was in before";
  }
  const target = valueOf(args, "-Path", "-LiteralPath") ?? plain(args)[0];
  if (push) ctx.dirs.push(ctx.here);
  if (target === undefined) {
    ctx.here = ctx.homedir ? normalize(ctx.homedir, ctx) : null;
    return "changes into the home folder";
  }
  const before = ctx.here;
  const unknown = target === "-" || target.includes("$") || (target.startsWith("~") && !ctx.homedir);
  ctx.here = unknown ? null : resolvePath(target, ctx);
  // cd .. leaves the project as surely as cd /tmp does.
  if (ctx.cwd && before && ctx.here && !isAbsolute(nativePath(target, ctx))) {
    const root = normalize(ctx.cwd, ctx).toLowerCase();
    const at = ctx.here.toLowerCase();
    const sep = ctx.windows ? "\\" : "/";
    if (at !== root && !at.startsWith(root.replace(/[\\/]$/, "") + sep)) ctx.outside.add(target);
  }
  return `changes into ${target}${ctx.here ? "" : ", a folder this explainer can't tell"}`;
}

// The paths whose existence a rating depends on, in the form exists() is asked.
// Unsure (no cwd, a $variable, no exists function, an unexpanded ~) counts as
// there, so a risk is never played down.
function exists(target, ctx) {
  if (!ctx.cwd || !ctx.existsFn || target.includes("$")) return true;
  if (target.startsWith("~") && !ctx.homedir) return true;
  const path = resolvePath(target, ctx);
  if (path === null) return true;
  try {
    return ctx.existsFn(path) !== false;
  } catch {
    return true;
  }
}

// Absolute paths outside the session's folder.
function checkPath(word, ctx) {
  if (!ctx.cwd || typeof word !== "string") return;
  if (word.startsWith("~") && !ctx.homedir) {
    ctx.outside.add(word);
    return;
  }
  const norm = (s) => {
    let p = nativePath(s, ctx).replace(/\\/g, "/");
    if (ctx.windows && /^\/[a-z]\//i.test(p)) p = `${p[1]}:${p.slice(2)}`;
    return p.replace(/\/+$/, "").toLowerCase() || "/";
  };
  // ../x climbs out of the folder the command is in; other relative words are
  // too often not paths at all (a commit message, a branch) to check.
  const up = /^\.\.([\\/]|$)/.test(word) ? resolvePath(word, ctx) : null;
  const p = norm(up ?? word);
  if (!/^([a-z]:)?\//.test(p) || p.startsWith("/dev/")) return;
  const root = norm(ctx.cwd);
  if (p !== root && !p.startsWith(root + "/")) ctx.outside.add(word);
}

// ---- What programs do ----

const prog = (w) => w.replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
const plain = (args) => args.filter((a) => !/^-/.test(a));
const short = (s, max = 60) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
const list = (items, max = 3) => items.slice(0, max).join(", ") + (items.length > max ? `, +${items.length - max} more` : "");

// A Unix flag, also inside a bundle like -rf. A PowerShell-style -Force is not a bundle.
function has(args, ...names) {
  return args.some((a) => {
    if (names.some((n) => a === n || a.startsWith(n + "="))) return true;
    if (!/^-[A-Za-z]{2,6}$/.test(a) || /^-[A-Z][a-z]/.test(a)) return false;
    return names.some((n) => /^-[A-Za-z]$/.test(n) && a.includes(n[1]));
  });
}

// A PowerShell parameter, which may be shortened (-Rec for -Recurse).
const psHas = (args, name) => args.some((a) => a.length > 3 && a.startsWith("-") && name.startsWith(a.slice(1).toLowerCase()));

function valueOf(args, ...flags) {
  for (let i = 0; i < args.length; i++) {
    for (const f of flags) {
      if (args[i].toLowerCase() === f.toLowerCase()) return args[i + 1];
      if (args[i].startsWith(f + "=")) return args[i].slice(f.length + 1);
    }
  }
  return undefined;
}

function remove(args, ctx) {
  const targets = list(plain(args)) || "files";
  const deep = has(args, "-r", "-R", "--recursive") || psHas(args, "recurse");
  const force = has(args, "-f", "--force") || psHas(args, "force");
  ctx.risk(`deletes ${targets}${deep ? " and everything inside" : ""}${force ? ", without asking" : ""}`, deep || force ? HIGH : ATTENTION);
  return `deletes ${targets}`;
}

function writeFile(args, ctx) {
  const file = valueOf(args, "-Path", "-FilePath") ?? plain(args)[0] ?? "a file";
  if (!exists(file, ctx)) return `writes a new file, ${file}`;
  ctx.risk(`overwrites ${file}`);
  return `writes ${file}, replacing it`;
}

function fetcher(args, ctx) {
  const url = args.find((a) => /^https?:\/\//i.test(a)) ?? valueOf(args, "-Uri") ?? plain(args).pop() ?? "a URL";
  const method = (valueOf(args, "-X", "--request", "-Method") ?? "").toUpperCase();
  const sends = has(args, "-d", "--data", "--data-raw", "--data-binary", "-F", "--form", "-T", "--upload-file") || psHas(args, "body") || ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const file = valueOf(args, "-o", "--output", "-OutFile") ?? (has(args, "-O") ? "a file named after the URL" : undefined);
  if (sends) ctx.risk(`sends data to ${url}`);
  if (file) ctx.changes();
  return `${sends ? `sends a ${method || "POST"} request to` : "downloads"} ${url}${file ? ` into ${file}` : ""}`;
}

function runScript(lang, kind) {
  return (args, ctx) => {
    if (has(args, "-e", "-c", "--eval") || psHas(args, "command")) return `runs inline ${lang} code`;
    if (args.includes("--test")) return "runs tests";
    if (args[0] === "-m") return `runs the ${lang} module ${args[1]}`;
    const file = plain(args[0] === "run" ? args.slice(1) : args)[0];
    if (!file) return `starts ${lang}`;
    return runFile(file, kind, ctx) ?? `runs the ${lang} script ${file}`;
  };
}

function nestedShell(args, ctx) {
  const code = valueOf(args, "-c", "-Command");
  if (code) {
    ctx.risk("runs a nested shell command, which isn't broken down here");
    return `runs a nested shell command: ${short(code, 50)}`;
  }
  const file = valueOf(args, "-File") ?? plain(args)[0];
  ctx.changes();
  if (!file) return "reads commands from its input and runs them";
  return runFile(file, /\.ps1$/i.test(file) ? "ps" : "shell", ctx) ?? `runs the script ${file}`;
}

function packageManager(pm) {
  const reads = new Set(["list", "ls", "outdated", "view", "info", "why", "show", "freeze", "audit"]);
  return (args, ctx) => {
    // --prefix web, -C web: the package.json in that folder.
    const dir = pm === "pip" ? undefined : valueOf(args, "--prefix", "-C", "--cwd", "--dir");
    const at = dir === undefined ? -1 : args.findIndex((a) => ["--prefix", "-c", "--cwd", "--dir"].includes(a.toLowerCase()));
    const [sub, ...rest] = plain(at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)]);
    if (!sub) return `runs ${pm}`;
    if (reads.has(sub)) return `looks up package information (${pm} ${sub})`;
    ctx.changes();
    if (["install", "i", "add", "ci"].includes(sub)) {
      ctx.risk("downloads packages, which can run their own install scripts", LOW);
      return rest.length ? `installs ${list(rest)}` : "installs the project's dependencies";
    }
    if (["uninstall", "remove", "rm", "un"].includes(sub)) return `removes the packages ${list(rest)}`;
    if (sub === "run" || sub === "run-script") {
      if (!rest[0]) return "lists the package.json scripts";
      return packageScript(pm, rest[0], dir, ctx) ?? `runs the "${rest[0]}" script from package.json`;
    }
    if (sub === "test" || sub === "t") return packageScript(pm, "test", dir, ctx) ?? "runs the project's tests";
    if (sub === "start") return packageScript(pm, "start", dir, ctx) ?? "starts the project (the \"start\" script)";
    if (sub === "publish") {
      ctx.risk("publishes this package to the registry, for anyone to install", HIGH);
      return "publishes the package";
    }
    if (["exec", "dlx", "x"].includes(sub)) {
      ctx.risk(`downloads and runs ${rest[0]} if it isn't installed`, LOW);
      // npx rimraf dist: a command this explainer knows is rated too, flags and
      // all. Any other is named as it was, without adding a warning of its own.
      const after = args.slice(args.indexOf(sub) + 1);
      while (after.length && after[0].startsWith("-")) after.shift();
      if (after.length && PROGRAMS[prog(after[0])]) inner(after, ctx);
      return `downloads (if needed) and runs ${rest[0]}`;
    }
    // yarn build, pnpm lint: a script's name works as a command.
    if (pm !== "npm" && pm !== "pip") return packageScript(pm, sub, dir, ctx, true) ?? `runs "${sub}", a package.json script or ${pm} command`;
    return `runs ${pm} ${sub}`;
  };
}

const GIT_READS = new Set(["status", "diff", "log", "show", "blame", "fetch", "grep", "ls-files", "rev-parse", "describe", "shortlog", "reflog"]);

function git(args, ctx) {
  const a = [...args];
  while (a.length && /^-[Cc]$/.test(a[0])) a.splice(0, 2);
  while (a.length && a[0].startsWith("-")) a.shift();
  const [sub, ...rest] = a;
  const names = plain(rest);
  const files = list(names);
  // branch, tag, remote and config only list or read with no names after them.
  const listing = ["branch", "tag", "remote"].includes(sub) && !names.length && !has(rest, "-d", "-D", "--delete");
  if (sub && !GIT_READS.has(sub) && !listing && !(sub === "config" && names.length < 2)) ctx.changes();
  switch (sub) {
    case undefined:
      return "runs git";
    case "status":
      return "shows which files changed";
    case "diff":
      return "shows line-by-line changes";
    case "log":
    case "show":
    case "blame":
    case "reflog":
      return "reads commit history";
    case "fetch":
      return "downloads remote changes without merging";
    case "add":
      return `stages ${files || "changes"} for the next commit`;
    case "commit":
      if (has(rest, "--amend")) ctx.risk("rewrites the last commit (--amend)");
      return "records a commit";
    case "push":
      if (has(rest, "-f", "--force", "--force-with-lease") || rest.some((r) => r.startsWith("+"))) ctx.risk("force-push: replaces history on the remote", HIGH);
      ctx.risk("publishes commits to the remote, where others can see them");
      return `uploads commits to ${names[0] ?? "the remote"}`;
    case "pull":
      return "downloads remote changes and merges them in";
    case "clone":
      return `downloads the repository ${names[0] ?? ""}`.trim();
    case "checkout":
    case "switch":
      if (rest.includes("--") || has(rest, "-f", "--force")) {
        ctx.risk("throws away uncommitted changes, which can't be undone", HIGH);
        return `restores ${files || "files"} from the last commit`;
      }
      return `switches to ${names[0] ?? "another branch"}`;
    case "restore":
      if (!has(rest, "--staged", "-S")) ctx.risk(`throws away uncommitted changes to ${files || "files"}, which can't be undone`, HIGH);
      return `restores ${files || "files"} from the last commit`;
    case "reset":
      if (has(rest, "--hard")) ctx.risk("throws away all uncommitted changes (reset --hard)", HIGH);
      return "moves the branch back to an earlier commit or unstages changes";
    case "clean":
      if (has(rest, "-f", "--force")) ctx.risk("deletes untracked files, which git can't bring back (git clean)", HIGH);
      return "removes untracked files";
    case "rebase":
      ctx.risk("rewrites commit history (rebase)");
      return "replays commits on top of another branch";
    case "merge":
      return `merges ${names[0] ?? "a branch"} into the current branch`;
    case "stash":
      if (["drop", "clear"].includes(rest[0])) ctx.risk("throws away stashed changes");
      return ["pop", "apply"].includes(rest[0]) ? "brings back stashed changes" : "sets aside uncommitted changes";
    case "branch":
      if (has(rest, "-D")) ctx.risk("deletes a branch even if it isn't merged");
      return has(rest, "-d", "-D", "--delete") ? `deletes the branch ${files}` : names.length ? `creates the branch ${names[0]}` : "lists branches";
    case "rm":
      ctx.risk(`deletes ${files || "files"} from the repository and the disk`);
      return `removes ${files || "files"}`;
    case "mv":
      return "renames files";
    case "tag":
      return names.length ? `creates the tag ${names[0]}` : "lists tags";
    case "init":
      return "creates a new repository";
    case "config":
      return names.length < 2 ? "reads git settings" : "changes git settings";
    case "remote":
      return names.length ? "changes remotes" : "lists remotes";
    case "cherry-pick":
      return "copies a commit onto the current branch";
    case "revert":
      return "adds a commit that undoes an earlier one";
    case "worktree":
      return "manages extra checkouts of the repository";
    default:
      return GIT_READS.has(sub) ? `reads from the repository (git ${sub})` : `runs git ${sub}`;
  }
}

function gh(args, ctx) {
  const [area, action] = plain(args);
  const reads = ["view", "list", "status", "diff", "checks", "browse"].includes(action) || area === "auth" || (area === "api" && !valueOf(args, "-X", "--method"));
  if (!reads) {
    ctx.changes();
    const level = action === "delete" || action === "merge" ? HIGH : ATTENTION;
    ctx.risk(`changes things on GitHub, where others can see them (gh ${[area, action].filter(Boolean).join(" ")})`, level);
  }
  if (area === "api") return `calls the GitHub API: ${action ?? ""}`.trim();
  return `GitHub CLI: ${[area, action].filter(Boolean).join(" ") || "gh"}`;
}

function containers(tool) {
  return (args, ctx) => {
    const sub = plain(args)[0] ?? "";
    if (["rm", "rmi", "prune", "delete", "destroy", "down"].includes(sub) || args.includes("prune")) ctx.risk(`removes ${tool} resources (${tool} ${sub})`);
    if (tool === "terraform" && ["apply", "destroy"].includes(sub)) ctx.risk(`changes real infrastructure (terraform ${sub})`, HIGH);
    if (tool === "kubectl" && ["apply", "delete", "scale", "rollout"].includes(sub)) ctx.risk(`changes a cluster (kubectl ${sub})`, HIGH);
    return `${tool} ${sub}`.trim();
  };
}

function build(tool) {
  return (args) => {
    const sub = plain(args)[0];
    return sub ? `${tool} ${sub}` : `runs ${tool}`;
  };
}

function stop(args, ctx) {
  ctx.risk(`stops running processes (${list(plain(args)) || "by name"})`);
  return "stops processes";
}

const show = (verb) => (args) => `${verb} ${list(plain(args)) || "its input"}`;

// Text tools take an expression, not a path: sed '/^a/,/^}/p', grep "/api/",
// jq .a. The positions of those arguments, which aren't checked as paths: the
// value of -e (or -Pattern), or else the first plain argument.
// Each tool's flags that take a value, which isn't the expression.
const AWK_VALUED = ["-F", "-v", "-f"];
const GREP_VALUED = ["-m", "-A", "-B", "-C", "-f"];
const EXPRESSION_FIRST = {
  sed: ["-f", "-l"], awk: AWK_VALUED, gawk: AWK_VALUED,
  grep: GREP_VALUED, egrep: GREP_VALUED, fgrep: GREP_VALUED,
  rg: [...GREP_VALUED, "-g", "-t", "-T", "--glob", "--type"],
  jq: ["--arg", "--argjson", "--slurpfile", "--rawfile", "-f"],
  findstr: [], "select-string": ["-Path", "-LiteralPath"], sls: ["-Path", "-LiteralPath"],
};

function expressionArgs(name, args) {
  const at = new Set();
  const valued = EXPRESSION_FIRST[name];
  if (!valued) return at;
  const ps = name === "select-string" || name === "sls";
  args.forEach((a, i) => {
    if (a === "-e" || ["--expression", "--regexp", "-pattern"].includes(a.toLowerCase())) at.add(i + 1);
  });
  if (at.size) return at;
  for (let i = 0; i < args.length; i++) {
    // jq --arg name value takes two; --arg's value is a string, not a path.
    if (["--arg", "--argjson"].includes(args[i])) at.add((i += 2));
    else if (["--slurpfile", "--rawfile"].includes(args[i])) i += 2;
    // Unix flags are case-sensitive (grep -F isn't -f); PowerShell's aren't.
    else if (valued.some((f) => (ps ? f.toLowerCase() === args[i].toLowerCase() : f === args[i]))) {
      // A value that names a file (-f prog.awk, -Path x) is checked; the rest
      // (awk -F /, grep -m 5, rg -g '*.ts') are text.
      if (!["-f", "-path", "-literalpath"].includes(ps ? args[i].toLowerCase() : args[i])) at.add(i + 1);
      i++;
    }
    else if (!args[i].startsWith("-")) {
      // awk -f prog.awk and sed -f script.sed name a file; what follows is input.
      if (!(["awk", "gawk", "sed"].includes(name) && args.includes("-f"))) at.add(i);
      break;
    }
  }
  return at;
}

const PROGRAMS = {
  // Looking around
  cd: changeDir,
  chdir: changeDir,
  "set-location": changeDir,
  sl: changeDir,
  pushd: (a, ctx) => changeDir(a, ctx, { push: true }),
  "push-location": (a, ctx) => changeDir(a, ctx, { push: true }),
  popd: (a, ctx) => changeDir(a, ctx, { pop: true }),
  "pop-location": (a, ctx) => changeDir(a, ctx, { pop: true }),
  pwd: () => "prints the current folder",
  ls: (a) => `lists files in ${list(plain(a)) || "this folder"}`,
  dir: (a) => `lists files in ${list(plain(a)) || "this folder"}`,
  "get-childitem": (a) => `lists files in ${list(plain(a)) || "this folder"}`,
  gci: (a) => `lists files in ${list(plain(a)) || "this folder"}`,
  tree: () => "prints the folder tree",
  cat: show("prints"),
  type: show("prints"),
  "get-content": show("prints"),
  gc: show("prints"),
  less: show("pages through"),
  head: show("shows the first lines of"),
  tail: (a) => (has(a, "-f", "--follow") ? `follows ${list(plain(a))} as it grows (keeps running)` : `shows the last lines of ${list(plain(a)) || "its input"}`),
  grep: (a) => `searches ${list(plain(a).slice(1)) || "its input"} for "${valueOf(a, "-e") ?? plain(a)[0]}"`,
  rg: (a) => `searches ${list(plain(a).slice(1)) || "this folder"} for "${valueOf(a, "-e") ?? plain(a)[0]}"`,
  findstr: (a) => `searches for "${plain(a)[0]}"`,
  "select-string": (a) => `searches for "${valueOf(a, "-Pattern") ?? plain(a)[0]}"`,
  sls: (a) => `searches for "${valueOf(a, "-Pattern") ?? plain(a)[0]}"`,
  find: (a, ctx) => {
    if (a.includes("-delete")) ctx.risk("deletes every file it finds (find -delete)", HIGH);
    const at = a.findIndex((x) => x === "-exec" || x === "-execdir");
    let each = "";
    if (at >= 0) {
      const end = a.findIndex((x, i) => i > at && (x === ";" || x === "\\;" || x === "+"));
      each = `, and runs ${inner(a.slice(at + 1, end < 0 ? undefined : end), ctx)} on each match`;
    }
    return `looks for files under ${plain(a)[0] ?? "this folder"}${each}`;
  },
  which: show("finds where this program lives:"),
  where: show("finds where this program lives:"),
  "get-command": show("finds where this program lives:"),
  "test-path": show("checks whether this exists:"),
  wc: show("counts lines and words in"),
  sort: () => "sorts lines",
  uniq: () => "drops repeated lines",
  cut: () => "picks out columns of text",
  tr: () => "swaps or deletes characters",
  jq: () => "reads or reshapes JSON",
  diff: (a) => `compares ${list(plain(a))}`,
  awk: () => "processes text line by line (awk)",
  od: show("shows the bytes of"),
  xxd: show("shows the bytes of"),
  hexdump: show("shows the bytes of"),
  sed: (a, ctx) => {
    if (has(a, "-i", "--in-place") || a.some((x) => x.startsWith("-i"))) {
      const files = list(plain(a).slice(1)) || "files";
      ctx.risk(`edits ${files} in place (sed -i)`);
      return `edits ${files} in place`;
    }
    return "rewrites text as it passes through (sed)";
  },
  xargs: (a, ctx) => {
    const at = a.findIndex((x) => !x.startsWith("-"));
    return `runs ${inner(at < 0 ? [] : a.slice(at), ctx)} once per input line`;
  },
  echo: () => "prints text",
  printf: () => "prints text",
  "write-output": () => "prints text",
  "write-host": () => "prints text",
  env: () => "prints the environment variables",
  printenv: () => "prints the environment variables",
  export: (a) => `sets ${list(a.map((x) => x.split("=")[0]))} for the rest of the command`,
  source: (a, ctx) => sourced(plain(a)[0], ctx),
  ".": (a, ctx) => sourced(plain(a)[0], ctx),
  "[": () => "checks a condition",
  "[[": () => "checks a condition",
  test: () => "checks a condition",
  set: () => "changes a shell setting",
  "set-strictmode": () => "changes a shell setting",
  local: () => "sets variables",
  declare: () => "sets variables",
  typeset: () => "sets variables",
  readonly: () => "sets variables",
  unset: () => "clears variables",
  shift: () => "moves on to the next argument",
  getopts: () => "reads the script's options",
  read: () => "reads a line of input",
  true: () => "does nothing",
  false: () => "does nothing",
  ":": () => "does nothing",
  return: () => "ends the function",
  exit: () => "ends the script",
  throw: () => "stops with an error",
  break: () => "leaves the loop",
  continue: () => "goes on to the next round of the loop",
  wait: () => "waits for steps running alongside to finish",
  trap: () => "sets what runs when the script ends or is interrupted",
  "write-error": () => "prints an error",
  "write-warning": () => "prints a warning",
  "write-verbose": () => "prints text",
  "join-path": () => "builds a path",
  "split-path": () => "splits a path",
  "resolve-path": () => "finds the full path",
  "get-location": () => "prints the current folder",
  "get-item": show("reads"),
  eval: (a, ctx) => {
    ctx.risk("runs text as code (eval)");
    return "runs text as code";
  },
  sleep: (a) => `waits ${plain(a)[0] ?? ""} seconds`.replace("  ", " "),
  "start-sleep": (a) => `waits ${plain(a)[0] ?? ""} seconds`.replace("  ", " "),
  date: () => "prints the date",
  "get-date": () => "prints the date",
  "select-object": () => "picks out parts of the piped objects",
  "where-object": () => "filters the piped objects",
  "foreach-object": (a, ctx) => `runs ${inner(a, ctx)} on each piped object`,
  "sort-object": () => "sorts the piped objects",
  "measure-object": () => "counts the piped objects",
  "format-table": () => "formats output as a table",
  "format-list": () => "formats output as a list",
  "convertfrom-json": () => "reads JSON",
  "convertto-json": () => "writes JSON",

  // Changing files
  mkdir: (a) => `creates the folder ${list(plain(a))}`,
  md: (a) => `creates the folder ${list(plain(a))}`,
  "new-item": (a) => `creates ${valueOf(a, "-Path") ?? plain(a)[0] ?? "an item"}`,
  ni: (a) => `creates ${valueOf(a, "-Path") ?? plain(a)[0] ?? "an item"}`,
  touch: (a) => `creates ${list(plain(a))} or updates its timestamp`,
  rm: remove,
  rmdir: remove,
  rd: remove,
  del: remove,
  erase: remove,
  "remove-item": remove,
  ri: remove,
  rimraf: (a, ctx) => {
    const targets = list(plain(a)) || "files";
    ctx.risk(`deletes ${targets} and everything inside, without asking`, HIGH);
    return `deletes ${targets}`;
  },
  mv: (a) => `moves ${list(plain(a).slice(0, -1))} to ${plain(a).at(-1)} (replacing anything there)`,
  move: (a) => `moves ${list(plain(a).slice(0, -1))} to ${plain(a).at(-1)} (replacing anything there)`,
  "move-item": (a) => `moves ${list(plain(a).slice(0, -1))} to ${plain(a).at(-1)} (replacing anything there)`,
  cp: (a) => `copies ${list(plain(a).slice(0, -1))} to ${plain(a).at(-1)}`,
  copy: (a) => `copies ${list(plain(a).slice(0, -1))} to ${plain(a).at(-1)}`,
  "copy-item": (a) => `copies ${list(plain(a).slice(0, -1))} to ${plain(a).at(-1)}`,
  ln: (a) => `links ${list(plain(a))}`,
  chmod: (a, ctx) => {
    if (a.includes("777")) ctx.risk("lets anyone read, change and run the files (chmod 777)");
    return `changes who can read, write or run ${list(plain(a).slice(1))}`;
  },
  chown: (a) => `changes the owner of ${list(plain(a).slice(1))}`,
  "set-content": writeFile,
  sc: writeFile,
  "out-file": writeFile,
  "add-content": (a) => `appends to ${valueOf(a, "-Path") ?? plain(a)[0]}`,
  tee: (a) => `copies its input into ${list(plain(a))}`,
  tar: (a, ctx) => {
    const action = has(a, "-x", "--extract") ? "unpacks an archive" : has(a, "-c", "--create") ? "packs files into an archive" : null;
    if (!action) return "lists what's in an archive";
    ctx.changes();
    return action;
  },
  zip: (a) => `packs files into ${plain(a)[0]}`,
  unzip: (a) => `unpacks ${plain(a)[0]}`,
  "expand-archive": (a) => `unpacks ${valueOf(a, "-Path") ?? plain(a)[0]}`,
  "compress-archive": () => "packs files into a zip",
  dd: (a, ctx) => {
    ctx.risk("copies raw data block by block, and can overwrite whole disks (dd)", HIGH);
    return "copies raw data";
  },

  // Running things
  git,
  gh,
  npm: packageManager("npm"),
  pnpm: packageManager("pnpm"),
  yarn: packageManager("yarn"),
  bun: packageManager("bun"),
  pip: packageManager("pip"),
  pip3: packageManager("pip"),
  npx: (a, ctx) => PROGRAMS.npm(["exec", ...a], ctx),
  bunx: (a, ctx) => PROGRAMS.npm(["exec", ...a], ctx),
  pnpx: (a, ctx) => PROGRAMS.npm(["exec", ...a], ctx),
  node: runScript("JavaScript", "js"),
  deno: runScript("JavaScript", "js"),
  python: runScript("Python", "python"),
  python3: runScript("Python", "python"),
  py: runScript("Python", "python"),
  uv: build("uv"),
  sh: nestedShell,
  bash: nestedShell,
  zsh: nestedShell,
  powershell: nestedShell,
  pwsh: nestedShell,
  cmd: (a, ctx) => {
    ctx.risk("runs a nested cmd.exe command, which isn't broken down here");
    return `runs a cmd.exe command: ${short(a.slice(1).join(" "), 50)}`;
  },
  iex: (a, ctx) => {
    ctx.risk("runs text as code (Invoke-Expression)", HIGH);
    return "runs text as code";
  },
  "invoke-expression": (a, ctx) => PROGRAMS.iex(a, ctx),
  "start-process": (a) => `starts ${valueOf(a, "-FilePath") ?? plain(a)[0]} as a separate program`,
  start: (a) => `starts ${plain(a)[0]} as a separate program`,
  claude: () => "runs Claude Code",
  make: build("make"),
  cargo: build("cargo"),
  go: build("go"),
  dotnet: build("dotnet"),
  mvn: build("mvn"),
  gradle: build("gradle"),
  gradlew: build("gradlew"),
  mvnw: build("mvnw"),
  tsc: () => "type-checks or compiles TypeScript",
  vite: build("vite"),
  docker: containers("docker"),
  "docker-compose": containers("docker-compose"),
  kubectl: containers("kubectl"),
  terraform: containers("terraform"),

  // Network and other machines
  curl: fetcher,
  wget: fetcher,
  "invoke-webrequest": fetcher,
  iwr: fetcher,
  "invoke-restmethod": fetcher,
  irm: fetcher,
  ssh: (a, ctx) => {
    ctx.risk(`connects to another machine (${plain(a)[0]})`);
    return `opens a shell on ${plain(a)[0]}`;
  },
  scp: (a, ctx) => {
    ctx.risk("copies files to or from another machine");
    return `copies ${list(plain(a))}`;
  },
  rsync: (a, ctx) => {
    if (has(a, "--delete")) ctx.risk("deletes files at the destination that aren't in the source (rsync --delete)", HIGH);
    return `syncs ${list(plain(a))}`;
  },

  // Processes
  kill: stop,
  pkill: stop,
  killall: stop,
  taskkill: stop,
  "stop-process": stop,
  spps: stop,
  ps: () => "lists running processes",
  "get-process": () => "lists running processes",
};

// Programs that only read. Any other known program counts as making changes (LOW),
// unless it's in SELF_RATED, which decides for itself.
const READS = new Set([
  "cd", "chdir", "set-location", "sl", "pushd", "push-location", "popd", "pop-location", "pwd", "ls", "dir", "get-childitem", "gci", "tree", "cat", "type", "get-content", "gc",
  "less", "head", "tail", "grep", "rg", "findstr", "select-string", "sls", "which", "where", "get-command",
  "test-path", "wc", "sort", "uniq", "cut", "tr", "jq", "diff", "awk", "od", "xxd", "hexdump", "echo", "printf", "write-output",
  "write-host", "env", "printenv", "export", "sleep", "start-sleep", "date", "get-date", "select-object",
  "where-object", "sort-object", "measure-object", "format-table", "format-list", "convertfrom-json",
  "convertto-json", "ps", "get-process",
  // The shell's own commands.
  "[", "[[", "test", "set", "set-strictmode", "local", "declare", "typeset", "readonly", "unset", "shift",
  "getopts", "read", "true", "false", ":", "return", "exit", "throw", "break", "continue", "wait", "trap",
  "write-error", "write-warning", "write-verbose", "join-path", "split-path", "resolve-path", "get-location",
  "get-item",
]);
const SELF_RATED = new Set([
  "git", "gh", "find", "sed", "xargs", "foreach-object", "tar", "npm", "pnpm", "yarn", "bun", "pip", "pip3",
  "npx", "bunx", "pnpx", "sh", "bash", "zsh", "powershell", "pwsh", "cmd", "iex", "invoke-expression",
  "curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "eval",
]);

// ---- Reading what a command runs ----

// A word naming a file to run rather than a program on the PATH: ./deploy.sh, build.ps1.
const SCRIPT_PATH = /[\\/]|\.(sh|bash|zsh|ps1|py|js|mjs|cjs)$/i;
const KINDS = { shell: "shell", ps: "PowerShell", python: "Python", js: "JavaScript" };
const EXTENSIONS = { sh: "shell", bash: "shell", zsh: "shell", ps1: "ps", py: "python", js: "js", mjs: "js", cjs: "js", ts: "js" };

// A file's text: undefined when there's no reader (the rating stays as it was
// without one), null when it couldn't be read.
function readText(path, ctx) {
  if (!ctx.readFn || !ctx.cwd || path.includes("$")) return undefined;
  const at = resolvePath(path, ctx);
  if (at === null) return null;
  try {
    const text = ctx.readFn(at);
    return typeof text === "string" ? text.slice(0, MAX_READ) : null;
  } catch {
    return null;
  }
}

// What a script holds, from its first line (#!/bin/bash) or its extension.
function scriptKind(path, text) {
  if (text.includes("\u0000")) return null;
  const first = text.slice(0, 200).split("\n")[0];
  if (first.startsWith("#!")) {
    if (/\b(bash|sh|zsh|dash|ksh)\b/.test(first)) return "shell";
    if (/python/.test(first)) return "python";
    if (/\b(node|deno|bun)\b/.test(first)) return "js";
    if (/pwsh|powershell/.test(first)) return "ps";
  }
  return EXTENSIONS[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()] ?? null;
}

// Reads a script that's about to run and rates what's in it. kind is shell, ps,
// python or js, or null to tell from the file. Returns what the step does, or
// null when there's no reader.
function runFile(path, kind, ctx) {
  const text = readText(path, ctx);
  if (text === undefined) return null;
  const base = path.replace(/\\/g, "/").split("/").pop();
  if (text === null) {
    ctx.risk(`runs ${base}, which couldn't be read`);
    return `runs ${path}, which couldn't be read; check what it does`;
  }
  const as = kind ?? scriptKind(path, text);
  if (!as) {
    ctx.risk(`runs ${base}, a program this explainer can't read`);
    return `runs ${path}, a program this explainer can't read; check what it does`;
  }
  ctx.changes();
  const found = withSource(base, ctx, () => (as === "python" || as === "js" ? scanCode(text, as, ctx) : rateShell(text, as === "ps", ctx)));
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  const read = found ? `${found} ${found === 1 ? "thing" : "things"} worth a look, below` : "nothing risky found";
  return `runs the ${KINDS[as]} script ${path} (${lines} ${lines === 1 ? "line" : "lines"}; read it: ${read})`;
}

// source x.sh, . ./x.ps1: the commands in the file, run in this shell.
function sourced(file, ctx) {
  if (!file) return "runs commands from a file in this shell";
  return runFile(file, null, ctx) ?? `runs the commands in ${file} in this shell`;
}

// A package.json script, and npm's pre and post scripts around it. bare is
// "yarn build": null when package.json has no such script, so it's a yarn command.
function packageScript(pm, name, dir, ctx, bare = false) {
  if (!name) return null;
  const at = dir ? `${dir.replace(/[\\/]+$/, "")}/package.json` : "package.json";
  const text = readText(at, ctx);
  if (text === undefined) return null;
  let scripts = null;
  try {
    scripts = JSON.parse(text ?? "null")?.scripts ?? null;
  } catch {
    // Not JSON: the script can't be looked up.
  }
  const body = scripts?.[name];
  if (typeof body !== "string") {
    if (bare) return null;
    // A missing package.json only makes npm fail; one in a folder that can't
    // be told could hold anything.
    if (text === null && resolvePath(at, ctx) === null) ctx.risk(`runs the "${name}" script from a package.json in a folder this explainer can't tell`);
    return text === null ? `runs the "${name}" script from package.json, which couldn't be read` : `runs the "${name}" script, which package.json doesn't have`;
  }
  const run = (pm === "npm" ? [`pre${name}`, name, `post${name}`] : [name]).filter((s) => typeof scripts[s] === "string");
  // A package script runs in its package.json's folder.
  const pkg = dir ? resolvePath(dir, ctx) : ctx.here;
  for (const s of run) withSource(`"${s}" script`, ctx, () => rateShell(scripts[s], false, ctx), pkg);
  const around = run.filter((s) => s !== name).map((s) => `"${s}"`);
  return `runs the "${name}" script from package.json${around.length ? ` (with ${around.join(" and ")})` : ""}: ${short(body, 60)}`;
}

// Whether a package script's program is installed in the project (node_modules/.bin).
// Unsure counts as not, so a program is never played down.
function projectTool(name, ctx) {
  if (!ctx.existsFn || !ctx.here) return false;
  try {
    return ctx.existsFn(resolvePath(`node_modules/.bin/${name}`, ctx)) === true;
  } catch {
    return false;
  }
}

// Rates a script's contents with its name in front of each risk found, and the
// programs in it this explainer doesn't know named once. Returns how many risks
// it found. A script that runs itself, or one too deep, isn't read again.
// pkgDir is the folder a package script runs in. A cd inside a script doesn't
// move the command that ran it.
function withSource(label, ctx, rate, pkgDir) {
  if (ctx.sources.has(label) || ctx.sources.size >= MAX_SOURCES) return 0;
  const saved = { ps: ctx.ps, source: ctx.source, unknown: ctx.unknown, pkgDir: ctx.pkgDir, nested: ctx.nested, heredoc: ctx.heredoc, here: ctx.here, dirs: ctx.dirs };
  const before = new Set(ctx.risks.keys());
  ctx.sources.add(label);
  Object.assign(ctx, { source: label, unknown: new Set(), dirs: [] });
  if (pkgDir !== undefined) Object.assign(ctx, { pkgDir, here: pkgDir });
  try {
    rate();
    if (ctx.unknown.size) ctx.risk(`runs programs this explainer doesn't know: ${list([...ctx.unknown])}`);
  } finally {
    ctx.sources.delete(label);
    Object.assign(ctx, saved);
  }
  return [...ctx.risks.keys()].filter((key) => !before.has(key)).length;
}

function rateShell(text, ps, ctx) {
  ctx.ps = ps;
  walk(text, ctx, 1);
}

// Python and JavaScript aren't shell, so they're searched for the calls that
// matter: deleting, writing, sending, and running other commands, which are
// rated like any command when they're written out in the file. Each kind of
// risk is named once, at its worst.
const CODE_RISKS = {
  python: [
    ["delete", /\bshutil\.rmtree\s*\(/, "deletes folders and everything inside (shutil.rmtree)", HIGH],
    ["delete", /\bos\.(remove|unlink|rmdir|removedirs)\s*\(|\.unlink\s*\(/, "deletes files", ATTENTION],
    ["write", /\bopen\s*\([^)\n]*,\s*(mode\s*=\s*)?['"][wax]|\.write_(text|bytes)\s*\(/, "writes files", LOW],
    ["send", /\b(requests|httpx)\.(post|put|patch|delete)\s*\(/, "sends data over the network", ATTENTION],
  ],
  js: [
    ["delete", /\b(rm|rmSync|rmdir|rmdirSync)\s*\([^)]*recursive\s*:\s*true|\brimraf\s*\(/, "deletes folders and everything inside", HIGH],
    ["delete", /\b(rm|rmSync|unlink|unlinkSync)\s*\(/, "deletes files", ATTENTION],
    ["write", /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(/, "writes files", LOW],
    ["send", /\bmethod\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]|\baxios\.(post|put|patch|delete)\s*\(/i, "sends data over the network", ATTENTION],
  ],
};
const DROPS = /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b|\bdrop_all\s*\(/i;
// Calls that run a command, and the command when it's written out: a string, or a list of strings.
const RUNS = {
  python: /\b(?:os\.system|os\.popen|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput))\s*\(\s*(?:\[([^\]]*)\]|[rbfu]*(['"])((?:\\.|(?!\2)[^\\\n])*)\2)?/g,
  js: /(?:^|[^\w.$]|\)\.|\b(?:child_process|childProcess|cp)\.)(execSync|execFileSync|spawnSync|execFile|exec|spawn)\s*\(\s*(?:(['"`])((?:\\.|(?!\2)[^\\])*)\2(?:\s*,\s*\[([^\]]*)\])?)?/g,
};
const strings = (src) => [...(src ?? "").matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);

function scanCode(text, lang, ctx) {
  const named = new Set();
  for (const [kind, pattern, what, level] of CODE_RISKS[lang]) {
    if (named.has(kind) || !pattern.test(text)) continue;
    named.add(kind);
    ctx.risk(what, level);
  }
  if (DROPS.test(text)) ctx.risk("drops database tables", HIGH);
  let unread = 0;
  for (const m of text.matchAll(RUNS[lang])) {
    const command = lang === "python" ? (m[1] !== undefined ? strings(m[1]).join(" ") : m[3]) : [m[3], ...strings(m[4])].filter((s) => s !== undefined).join(" ");
    if (command && command.trim()) rateShell(command, false, ctx);
    // A bare .exec() is a regex's or a database query's, not a command.
    else if (lang === "python" || m[1] !== "exec") unread++;
  }
  if (unread) ctx.risk("runs other commands, built while it runs, which aren't broken down here");
}

// ---- Splitting a command into steps ----

// { steps: [{ words, redirects: [{ op, target }], joiner }], nested, heredoc }.
// Quotes are removed; a $(…) or backtick part stays inside its word, and its
// source is also returned in nested so it can be explained (and rated) too.
export function parse(src, ps = false) {
  const tokens = [];
  const heredocs = [];
  const nested = [];
  let word = null;
  let heredoc = false;
  const push = () => {
    if (word !== null) tokens.push({ t: "word", v: word });
    word = null;
  };
  const add = (s) => (word = (word ?? "") + s);

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end;
      add(src.slice(i + 1, stop));
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (!ps && src[j] === "\\" && '"\\$`'.includes(src[j + 1])) {
          s += src[j + 1];
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "(") {
          const end = closeParen(src, j + 1);
          nested.push(src.slice(j + 2, end));
          s += src.slice(j, end + 1);
          j = end + 1;
        } else s += src[j++];
      }
      add(s);
      i = j;
    } else if (!ps && c === "\\" && i + 1 < src.length) {
      if (src[i + 1] !== "\n") add(src[i + 1]);
      i++;
    } else if (c === "$" && src[i + 1] === "(") {
      const end = closeParen(src, i + 1);
      nested.push(src.slice(i + 2, end));
      add(src.slice(i, end + 1));
      i = end;
    } else if (c === "`" && !ps) {
      const end = src.indexOf("`", i + 1);
      const stop = end < 0 ? src.length - 1 : end;
      nested.push(src.slice(i + 1, stop));
      add(src.slice(i, stop + 1));
      i = stop;
    } else if (c === "#" && word === null) {
      while (i + 1 < src.length && src[i + 1] !== "\n") i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      push();
    } else if (c === "\n") {
      push();
      tokens.push({ t: "op", v: ";" });
      // A here-document's body is text, not commands: skip to its closing line.
      while (heredocs.length) i = skipHeredoc(src, i + 1, heredocs.shift()) - 1;
    } else if (two === "&&" || two === "||") {
      push();
      tokens.push({ t: "op", v: two });
      i++;
    } else if (c === "&" && src[i + 1] === ">") {
      push();
      const op = src[i + 2] === ">" ? "&>>" : "&>";
      tokens.push({ t: "redir", v: op });
      i += op.length - 1;
    } else if (c === "|" || c === ";" || (c === "&" && !ps)) {
      push();
      tokens.push({ t: "op", v: c });
      if (two === "|&") i++;
    } else if (c === "&") {
      push(); // PowerShell's call operator: the next word is the program
    } else if (c === ">" || c === "<") {
      let fd = "";
      if (word !== null && /^(\d|\*)$/.test(word)) {
        fd = word === "*" ? "&" : word;
        word = null;
      } else push();
      const op = /^(>>|>&|>\||>|<<<|<<-|<<|<)/.exec(src.slice(i))[0];
      i += op.length - 1;
      if (op === ">&") {
        while (/[\d-]/.test(src[i + 1] ?? "")) i++; // 2>&1: joins two outputs, no file
      } else if (op === "<<" || op === "<<-") {
        let j = i + 1;
        while (src[j] === " ") j++;
        let k = j;
        while (k < src.length && !/[\s;|&<>)]/.test(src[k])) k++;
        const delim = src.slice(j, k).replace(/['"\\]/g, "");
        heredocs.push(delim);
        heredoc = true;
        tokens.push({ t: "redir", v: op }, { t: "word", v: delim });
        i = k - 1;
      } else {
        tokens.push({ t: "redir", v: fd + op.replace(">|", ">") });
      }
    } else {
      add(c);
    }
  }
  push();

  const steps = [];
  let cur = { words: [], redirects: [], joiner: null };
  let redir = null;
  for (const tok of tokens) {
    if (tok.t === "op") {
      if (cur.words.length || cur.redirects.length) steps.push(cur);
      cur = { words: [], redirects: [], joiner: tok.v };
    } else if (tok.t === "redir") {
      redir = tok.v;
    } else if (redir) {
      cur.redirects.push({ op: redir, target: tok.v });
      redir = null;
    } else {
      cur.words.push(tok.v);
    }
  }
  if (cur.words.length || cur.redirects.length) steps.push(cur);
  return { steps, nested, heredoc };
}

// From the start of a here-document's body, the index just past its closing line.
function skipHeredoc(src, from, delim) {
  let j = from;
  for (;;) {
    const nl = src.indexOf("\n", j);
    const line = src.slice(j, nl < 0 ? src.length : nl);
    j = nl < 0 ? src.length : nl + 1;
    if (nl < 0 || line.trim() === delim) return j;
  }
}

// The ) that closes the ( at open. Quotes and here-document bodies (a commit
// message full of apostrophes and brackets) don't count.
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const doc = c === "<" && /^<<-?[ \t]*['"]?([A-Za-z_][\w-]*)['"]?/.exec(src.slice(i));
    if (doc && src[i + 2] !== "<") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return src.length - 1;
      i = skipHeredoc(src, nl + 1, doc[1]) - 1;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" && c === '"' ? 2 : 1;
      if (j >= src.length) return src.length - 1;
      i = j;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return src.length - 1;
}
