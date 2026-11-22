import semver from "semver";

/** Why `range` is not a semver range, or undefined when it is one. */
export function engineRangeProblem(range: string): string | undefined {
  return semver.validRange(range) === null
    ? `"${range}" is not a semver range; write a range such as ">=0.2.0 <0.4.0" or "^0.2.0"`
    : undefined;
}

/**
 * Why an engine at `version` does not meet `range` (a graph's `requires.engine`), or
 * undefined when it does. A version that is not semver cannot be compared and passes.
 */
export function engineVersionProblem(range: string, version: string): string | undefined {
  const invalid = engineRangeProblem(range);
  if (invalid) return invalid;
  if (semver.valid(version) === null) return undefined;
  if (semver.satisfies(version, range, { includePrerelease: true })) return undefined;
  return `this graph requires flowgraph ${range}, but this is flowgraph ${version}; run it on a flowgraph that satisfies that range, or change requires.engine`;
}
