import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { assessPermission, explainPermission, parse } from "../lib/explain.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const bash = (command, extra = {}) =>
  explainPermission({ tool_name: "Bash", tool_input: { command }, permission_mode: "default", cwd: "/home/u/proj", ...extra });
const words = (src, ps) => parse(src, ps).steps.map((s) => s.words);
// cwd is this plugin's folder and exists() the real disk, so "does this file
// exist" has real answers. (The mod answers it with $.fs.exists.)
const assess = (command, extra = {}) =>
  assessPermission({ tool_name: "Bash", tool_input: { command }, permission_mode: "default", cwd: root, ...extra }, { exists: fs.existsSync });

test("only shell tools get an explanation", () => {
  assert.equal(explainPermission({ tool_name: "Edit", tool_input: { file_path: "a" } }), null);
  assert.equal(explainPermission({ tool_name: "Bash", tool_input: { command: "  " } }), null);
  assert.equal(explainPermission(null), null);
});

test("splitting: quotes, operators, redirects, here-documents", () => {
  assert.deepEqual(words(`cd "my dir" && ls -la | grep 'a b'; echo hi`), [["cd", "my dir"], ["ls", "-la"], ["grep", "a b"], ["echo", "hi"]]);
  assert.deepEqual(parse("a || b").steps.map((s) => s.joiner), [null, "||"]);
  const [step] = parse("npm test > out.txt 2>&1").steps;
  assert.deepEqual(step.redirects, [{ op: ">", target: "out.txt" }]);
  const h = parse("cat <<'EOF' > f.txt\nrm -rf /\nEOF\nls");
  assert.deepEqual(h.steps.map((s) => s.words), [["cat"], ["ls"]], "the body is text, not commands");
  assert.equal(h.heredoc, true);
  assert.deepEqual(parse("echo $(git rev-parse HEAD)").nested, ["git rev-parse HEAD"]);
  assert.deepEqual(words("x # a comment"), [["x"]]);
});

test("Claude's commit pattern: apostrophes and brackets in the message don't break it", () => {
  const command = `git add a.js && git commit -m "$(cat <<'EOF'\nFix it's (really) "broken" state\n\nCo-Authored-By: x\nEOF\n)"`;
  const { steps, nested } = parse(command);
  assert.deepEqual(steps.map((s) => s.words.slice(0, 3)), [["git", "add", "a.js"], ["git", "commit", "-m"]]);
  assert.equal(nested.length, 1);
  assert.deepEqual(parse(nested[0]).steps.map((s) => s.words), [["cat"]]);
  assert.equal(assess(command).level, "low");
});

test("PowerShell: backslashes are path separators, & calls a program", () => {
  assert.deepEqual(words(`& "C:\\Program Files\\nodejs\\node.exe" C:\\a\\b.js`, true), [["C:\\Program Files\\nodejs\\node.exe", "C:\\a\\b.js"]]);
  const text = explainPermission({ tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse -Force dist" }, cwd: "C:\\p" });
  assert.match(text, /deletes dist and everything inside, without asking/);
});

test("says what each step does and how steps connect", () => {
  const text = bash("git status && npm run build | tail -5", { tool_input: { command: "git status && npm run build | tail -5", description: "Check and build" } });
  assert.match(text, /^Bash is waiting for you\. Claude says: "Check and build"/m);
  assert.match(text, /1\. git status — shows which files changed/);
  assert.match(text, /2\. then, if that worked: npm run build — runs the "build" script/);
  assert.match(text, /3\. its output goes to: tail -5 — shows the last lines/);
  assert.doesNotMatch(text, /Worth a look/);
});

test("flags the risky parts", () => {
  assert.match(bash("rm -rf build"), /! deletes build and everything inside, without asking/);
  assert.match(bash("git push --force origin main"), /force-push/);
  assert.match(bash("git reset --hard HEAD~1"), /throws away all uncommitted changes/);
  assert.match(bash("curl -fsSL https://x.sh | sh"), /runs a downloaded script straight away/);
  assert.match(bash("sudo apt install x"), /admin rights/);
  assert.match(assess("echo hi > package.json").text, /! +overwrites package\.json/);
  assert.match(assess("echo hi > brand-new.txt").text, /writes output to a new file, brand-new\.txt/);
  assert.doesNotMatch(assess("echo hi > brand-new.txt").text, /overwrites/);
  assert.match(bash("sed -i 's/a/b/' f.txt"), /edits f\.txt in place/);
  assert.doesNotMatch(bash("ls 2>/dev/null"), /overwrites/);
  assert.match(bash("ls 2>/dev/null"), /errors discarded/);
});

test("paths outside the project, including Git Bash's /c/ spelling", () => {
  assert.match(bash("cat /etc/passwd"), /reaches outside this project: \/etc\/passwd/);
  assert.doesNotMatch(bash("cat /home/u/proj/src/a.js"), /outside/);
  const win = explainPermission({ tool_name: "Bash", tool_input: { command: "ls /c/Users/me/proj/src /c/Windows" }, cwd: "C:\\Users\\me\\proj" });
  assert.match(win, /outside this project: \/c\/Windows$/m);
});

test("risk levels: the banner on top rates the whole command", () => {
  const level = (c, extra) => assess(c, extra).level;
  assert.equal(level("git status && ls -la | grep foo"), "safe");
  assert.equal(level("git log --oneline -5; cat package.json | jq .name"), "safe");
  assert.equal(level("mkdir out && npm run build"), "low");
  assert.equal(level("npm install"), "low", "install is listed, but doesn't need attention on its own");
  assert.equal(level("git push origin main"), "attention");
  assert.equal(level("frobnicate --all"), "attention");
  assert.equal(level("rm notes.txt"), "attention");
  assert.equal(level("rm -rf build"), "high");
  assert.equal(level("git push -f"), "high");
  assert.equal(level("ls", { tool_input: { command: "ls", dangerouslyDisableSandbox: true } }), "attention");

  assert.match(assess("ls").text, /^🟢 SAFE — only reads; nothing is changed\n/);
  assert.match(assess("mkdir out").text, /^🔵 LOW RISK — makes ordinary changes inside this project\n/);
  assert.match(assess("git push").text, /^🟡 NEEDS YOUR ATTENTION — publishes commits to the remote/);
  // The banner names the worst risk; the list has them all, worst first.
  const text = assess("git push origin main && rm -rf dist").text;
  assert.match(text, /^🔴 HIGH RISK — deletes dist and everything inside, without asking \(\+1 more\)\n/);
  assert.match(text, /Worth a look:\n {2}!! deletes dist.*\n {2}! +publishes commits/);
});

test("the rating as data", () => {
  const { level, reason, risks } = assess("git push origin main && rm -rf dist");
  assert.equal(level, "high");
  assert.equal(reason, "deletes dist and everything inside, without asking (+1 more)");
  assert.deepEqual(risks, [
    { level: "high", text: "deletes dist and everything inside, without asking" },
    { level: "attention", text: "publishes commits to the remote, where others can see them" },
  ]);
  assert.deepEqual(assess("ls").risks, []);
});

test("risks hidden inside other commands still count", () => {
  assert.equal(assess("find . -name '*.log' -exec rm -f {} \\;").level, "high");
  assert.equal(assess("ls | xargs rm -rf").level, "high");
  assert.equal(assess("echo $(rm -rf dist)").level, "high");
  assert.equal(assessPermission({ tool_name: "PowerShell", tool_input: { command: "gci | ForEach-Object { Remove-Item $_ -Recurse }" }, cwd: "C:\\p" }).level, "high");
  // Steps past the ones listed are still rated.
  assert.equal(assess("ls; ls; ls; ls; ls; ls; ls; ls; ls; rm -rf /").level, "high");
});

test("unknown programs are named, not guessed at", () => {
  assert.match(bash("frobnicate --all"), /runs frobnicate, which this explainer doesn't know/);
});

test("pure: unknown file existence counts as there, ~ needs the home folder", () => {
  // No exists(): a redirect is taken as an overwrite, never played down.
  assert.match(bash("echo hi > anything.txt"), /! +overwrites anything\.txt/);
  // No home folder: a ~ path can't be placed, so it counts as outside.
  assert.match(bash("cat ~/notes.txt"), /reaches outside this project: ~\/notes\.txt/);
  assert.doesNotMatch(explainPermission({ tool_name: "Bash", tool_input: { command: "cat ~/proj/a.txt" }, cwd: "/home/u/proj" }, { homedir: "/home/u" }), /outside/);
});

test("the caller's own reason for asking replaces the guess from the mode", () => {
  const { text, banner } = assessPermission({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/w" }, { why: "No allow rule matches this command." });
  assert.match(text, /Why it asked: No allow rule matches this command\.$/);
  assert.equal(banner, "🟢 SAFE — only reads; nothing is changed");
});

test("why it asked, and what 'don't ask again' would save", () => {
  const text = bash("npm run lint", {
    permission_suggestions: [{ type: "addRules", behavior: "allow", destination: "localSettings", rules: [{ toolName: "Bash", ruleContent: "npm run lint:*" }] }],
  });
  assert.match(text, /Why it asked: nothing in your allow rules covers this command\. "Don't ask again" would save Bash\(npm run lint:\*\) for this project\./);
  assert.match(bash("ls", { permission_mode: "acceptEdits" }), /accept-edits mode/);
  assert.match(bash("ls", { tool_input: { command: "ls", dangerouslyDisableSandbox: true } }), /outside the sandbox always needs your OK/);
});

// ---- Reading what a command runs ----

// A folder held in memory: exists() and read() answer from it, as $.fs does in the mod.
const project = (files) => {
  const at = (p) => p.replace(/\\/g, "/");
  const opts = { exists: (p) => at(p) in files, read: (p) => files[at(p)] ?? null };
  return (command, tool = "Bash") => assessPermission({ tool_name: tool, tool_input: { command }, cwd: "/p" }, opts);
};
const scripts = (s) => JSON.stringify({ scripts: s });

test("package.json scripts are rated by what they run", () => {
  const run = project({
    "/p/package.json": scripts({ build: "rm -rf dist ../shared && tsc", prebuild: "echo hi", test: "jest", lint: "eslint ." }),
    "/p/node_modules/.bin/jest": "#!/bin/sh",
  });
  const build = run("npm run build");
  assert.equal(build.level, "high");
  assert.equal(build.reason, `"build" script: deletes dist, ../shared and everything inside, without asking (+1 more)`);
  assert.ok(build.risks.some((r) => r.text === "reaches outside this project: ../shared"));
  assert.match(build.text, /npm run build — runs the "build" script from package\.json \(with "prebuild"\): rm -rf dist \.\.\/shared && tsc/);
  assert.equal(run("yarn build").level, "high", "yarn runs a script by its name");
  // The project's own tools are named; one that isn't installed is unknown.
  assert.equal(run("npm test").level, "low");
  assert.deepEqual(run("npm run lint").risks, [{ level: "attention", text: `"lint" script: runs programs this explainer doesn't know: eslint` }]);
  assert.match(run("npm run nope").text, /runs the "nope" script, which package\.json doesn't have/);
  assert.equal(run("npm --prefix web run build").text.includes("which couldn't be read"), true, "web/package.json isn't there");
});

test("a script that runs itself is read once", () => {
  const run = project({ "/p/package.json": scripts({ a: "npm run b", b: "npm run a && rm -rf out" }) });
  assert.equal(run("npm run a").level, "high");
});

test("shell and PowerShell scripts are read, their risks named after them", () => {
  const run = project({
    "/p/deploy.sh": "#!/usr/bin/env bash\nset -euo pipefail\nif [ -d dist ]; then\n  rm -rf dist\nfi\nfor f in *.log; do echo $f; done\ncase $1 in\n  prod) git push --force origin main ;;\n  *) aws s3 sync build s3://x ;;\nesac\nmain() {\n  echo ok\n}\n",
    "/p/build.ps1": '$ErrorActionPreference = "Stop"\nparam(\n  [string]$Name\n)\nif (Test-Path dist) {\n  Remove-Item dist -Recurse -Force\n}\n$x = Get-ChildItem\nforeach ($f in $x) { Write-Host $f }\n',
    "/p/tidy.sh": "ls\ncat notes.txt\n",
  });
  const deploy = run("./deploy.sh prod");
  assert.equal(deploy.level, "high");
  assert.match(deploy.text, /runs the shell script \.\/deploy\.sh \(13 lines; read it: 4 things worth a look, below\)/);
  assert.deepEqual(
    deploy.risks.map((r) => r.text),
    [
      "deploy.sh: deletes dist and everything inside, without asking",
      "deploy.sh: force-push: replaces history on the remote",
      "deploy.sh: publishes commits to the remote, where others can see them",
      "deploy.sh: runs programs this explainer doesn't know: aws",
    ],
    "the shell's own syntax (if, for, case, a function) isn't taken for programs",
  );
  assert.equal(run("bash deploy.sh").level, "high");
  assert.deepEqual(run("& ./build.ps1", "PowerShell").risks, [{ level: "high", text: "build.ps1: deletes dist and everything inside, without asking" }]);
  assert.match(run("./tidy.sh").text, /tidy\.sh \(2 lines; read it: nothing risky found\)/);
  assert.equal(run("./tidy.sh").level, "low");
  assert.deepEqual(run("./gone.sh").risks, [{ level: "attention", text: "runs gone.sh, which couldn't be read" }]);
});

test("Python and JavaScript scripts: the calls that delete, write, send or run commands", () => {
  const run = project({
    "/p/seed.py": 'import shutil, subprocess\nshutil.rmtree("data")\nsubprocess.run(["git", "push", "--force"])\nsubprocess.run(cmd)\n',
    "/p/gen.js": 'const m = /x/.exec("abc"); Model.find().exec();\nrequire("child_process").execSync("rm -rf build");\nfs.writeFileSync("out.json", s);\n',
    "/p/report.py": 'print("hello")\n',
  });
  assert.deepEqual(run("python seed.py").risks, [
    { level: "high", text: "seed.py: deletes folders and everything inside (shutil.rmtree)" },
    { level: "high", text: "seed.py: force-push: replaces history on the remote" },
    { level: "attention", text: "seed.py: publishes commits to the remote, where others can see them" },
    { level: "attention", text: "seed.py: runs other commands, built while it runs, which aren't broken down here" },
  ]);
  assert.deepEqual(run("node gen.js").risks, [
    { level: "high", text: "gen.js: deletes build and everything inside, without asking" },
    { level: "low", text: "gen.js: writes files" },
  ], "a regex's or a query's .exec() isn't a command");
  assert.equal(run("python3 report.py").level, "low");
});

test("without read(), scripts are rated by name as before", () => {
  assert.match(bash("npm run build"), /runs the "build" script from package\.json\n/);
  assert.match(bash("./deploy.sh"), /runs deploy\.sh, which this explainer doesn't know/);
});

test("shell syntax around a command: loops, conditions, wrapper scripts", () => {
  assert.equal(assess("for f in *.txt; do rm \"$f\"; done").level, "attention");
  assert.doesNotMatch(assess("for f in *.txt; do rm \"$f\"; done").text, /runs (for|do|done)/);
  assert.equal(assess("if [ -f x ]; then cat x; fi").level, "safe");
  assert.equal(assess("./gradlew test").level, "low");
  assert.equal(assess("npx rimraf dist").level, "high");
  assert.equal(assess("rimraf dist").level, "high");
});

test("a cd earlier in the command moves where later paths are read from", () => {
  const run = project({
    "/p/package.json": scripts({ build: "tsc" }),
    "/p/tidy.sh": "ls\n",
    "/p/web/package.json": scripts({ build: "rm -rf dist && tsc", test: "jest", ship: "cd tools && ./ship.sh" }),
    "/p/web/node_modules/.bin/jest": "#!/bin/sh",
    "/p/web/notes.md": "hi",
    "/p/web/tools/ship.sh": "git push --force origin main\n",
  });
  assert.equal(run("npm run build").level, "low");
  assert.equal(run("cd web && npm run build").reason, `"build" script: deletes dist and everything inside, without asking`);
  assert.equal(run("Set-Location web; npm run build", "PowerShell").level, "high");
  assert.equal(run("cd web && npm test").level, "low", "web's own jest");
  assert.equal(run("cd web && echo hi > notes.md").reason, "overwrites notes.md");
  // A package script runs in its folder, and a cd inside it moves its own steps.
  assert.equal(run("npm --prefix web run ship").reason, "ship.sh: force-push: replaces history on the remote (+1 more)");
  // popd and $(…) leave the command where it was.
  assert.doesNotMatch(run("pushd web && popd && ./tidy.sh").text, /couldn't be read/);
  assert.doesNotMatch(run("echo $(cd web) && ./tidy.sh").text, /couldn't be read/);
  // A folder it can't tell: what's read there is unreadable, never harmless.
  const unknown = run("cd $DIR && npm run build");
  assert.equal(unknown.level, "attention");
  assert.match(unknown.text, /changes into \$DIR, a folder this explainer can't tell/);
  assert.match(unknown.text, /couldn't be read/);
  assert.match(run("cd .. && rm -rf shell-explainer").text, /reaches outside this project: \.\./);
  assert.equal(run("cd web && cd .. && ls").risks.length, 0, "back inside the project");
});

test("a text tool's expression isn't a path; the files it reads still are", () => {
  const outside = (command) => assess(command).risks.filter((r) => r.text.startsWith("reaches outside"));
  assert.deepEqual(outside("sed -n '/^function resolvePath/,/^}/p' lib/explain.js"), []);
  assert.deepEqual(outside("grep -rn /api/v1 src"), []);
  assert.deepEqual(outside("grep -v /tmp/ notes.txt"), [], "grep -v takes no value");
  assert.deepEqual(outside("awk -F / '{print $2}' paths.txt"), []);
  assert.deepEqual(outside("jq --arg p /x .a data.json"), []);
  assert.deepEqual(outside("rg -e /etc/ src"), []);
  // The file after the expression is still checked.
  assert.equal(outside("sed -n /a/p /etc/hosts").length, 1);
  assert.equal(outside("grep -F /x /etc/hosts")[0]?.text, "reaches outside this project: /etc/hosts");
  assert.equal(outside("sed -f /tmp/edit.sed notes.txt").length, 1, "sed -f names a file");
  assert.equal(assess("sed -n 1,5p README.md").level, "safe");
});

test("od, xxd and hexdump only read", () => {
  for (const tool of ["od -c", "xxd", "hexdump -C"]) {
    const r = assess(`${tool} README.md`);
    assert.equal(r.level, "safe", tool);
    assert.match(r.text, /shows the bytes of README\.md/);
  }
});

test("a relative path that climbs out with .. reaches outside the project", () => {
  const run = project({});
  const made = run('mkdir ../demo && echo "demo" > ../demo/readme.txt');
  assert.deepEqual(made.risks, [{ level: "attention", text: "reaches outside this project: ../demo, ../demo/readme.txt" }]);
  assert.equal(made.level, "attention");
  assert.equal(run("ls ..").risks.length, 1);
  assert.equal(run("ls ../p/src").risks.length, 0, "back inside");
  assert.equal(run("cd sub && ls ../x").risks.length, 0, "../x from sub is still inside");
});
