// Types for explain.js, for the hooks module and the tests.

export type RiskLevel = "safe" | "low" | "attention" | "high";

export type Assessment = {
  level: RiskLevel;
  /** The banner's words: the biggest reason for the level. */
  reason: string;
  /** The one line on top, such as "🔴 HIGH RISK — force-push: …". */
  banner: string;
  risks: { level: RiskLevel; text: string }[];
  /** The whole explanation, banner first. */
  text: string;
};

export type AssessInput = {
  tool_name?: string;
  tool_input?: { command?: unknown; description?: unknown; run_in_background?: unknown; dangerouslyDisableSandbox?: unknown };
  cwd?: string;
  permission_mode?: string;
  permission_suggestions?: unknown;
};

export type AssessOptions = {
  /** Whether an absolute path exists. Without it, a path counts as there. */
  exists?: (path: string) => boolean;
  /**
   * An absolute path's text, or null when it can't be read, so the scripts a
   * command runs (package.json's scripts, ./deploy.sh, python seed.py) are rated
   * by what they hold. Without it, they're rated by their name alone.
   */
  read?: (path: string) => string | null | undefined;
  /** The home folder, for ~ paths. Without it, a ~ path counts as outside the project. */
  homedir?: string;
  /** Why Claude Code asked, in a sentence. */
  why?: string;
};

export function assessPermission(input: AssessInput | null | undefined, options?: AssessOptions): Assessment | null;
export function explainPermission(input: AssessInput | null | undefined, options?: AssessOptions): string | null;
export function parse(src: string, ps?: boolean): { steps: { words: string[]; redirects: { op: string; target: string }[]; joiner: string | null }[]; nested: string[]; heredoc: boolean };
