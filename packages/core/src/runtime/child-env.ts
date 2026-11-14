/**
 * Default host environment inherited by `shell` and `script` children.
 *
 * Keep this list minimal: operational paths and locale only, never credentials.
 * Authors opt in anything else with shell `with.inheritEnv` or explicit `with.env`.
 *
 * Included:
 * - PATH — locate binaries (already required before this allowlist existed)
 * - HOME, TMPDIR, and Windows TEMP/TMP — user and temp dirs used by git, npm, ssh, gh
 * - LANG, LC_ALL — locale / UTF-8; no secrets
 * - SystemRoot, WINDIR — required for many Windows programs
 *
 * Not included (not required once HOME is present; opt in if a graph needs them):
 * - USER, SHELL
 */

export const DEFAULT_INHERITED_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "WINDIR",
] as const;

/** Copy the named host variables that are actually set. Missing names are omitted. */
export function pickHostEnv(names: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (Object.hasOwn(process.env, name)) env[name] = process.env[name];
  }
  return env;
}
