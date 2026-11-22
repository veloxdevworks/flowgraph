/**
 * `flowgraph migrate` — rewrites pre-v1 graph specs toward the current
 * `flowgraph/v1` contract. Operates on raw YAML text to preserve comments and
 * formatting; rewrites are idempotent so running twice produces no diff.
 */

import { migrateDataContracts } from "./migrate-data-contracts.js";

export interface MigrateResult {
  changed: boolean;
  output: string;
  notes: string[];
  /** Rewrites that need a decision; the fields are left as they are. */
  manual: string[];
}

const CURRENT_API_VERSION = "flowgraph/v1";

const CANONICAL_KINDS: Record<string, string> = {
  graph: "Graph",
  subgraph: "Graph",
  skill: "Skill",
};

const NODE_TYPE_RENAMES: Record<string, string> = {
  code: "function",
  intelligent: "agent",
};

const HOOK_EVENT_RENAMES: Record<string, string> = {
  "intelligent:beforeToolCall": "agent:beforeToolCall",
  "intelligent:afterToolCall": "agent:afterToolCall",
};

export function migrateSpec(raw: string): MigrateResult {
  let output = raw;
  const notes: string[] = [];

  // 1. apiVersion → flowgraph/v1
  output = output.replace(
    /^(\s*apiVersion\s*:\s*)(['"]?)([^'"\n#]+?)(\2)(\s*(?:#.*)?)$/gm,
    (match, prefix: string, _q: string, value: string, _q2: string, trailing: string) => {
      const trimmed = value.trim();
      if (trimmed === CURRENT_API_VERSION) return match;
      notes.push(`apiVersion: "${trimmed}" → "${CURRENT_API_VERSION}"`);
      return `${prefix}${CURRENT_API_VERSION}${trailing ?? ""}`;
    },
  );

  // 2. kind → Graph (canonical capitalization, and Subgraph → Graph)
  output = output.replace(
    /^(\s*kind\s*:\s*)(['"]?)([A-Za-z]+)(\2)(\s*(?:#.*)?)$/gm,
    (match, prefix: string, _q: string, value: string, _q2: string, trailing: string) => {
      const canonical = CANONICAL_KINDS[value.toLowerCase()];
      if (!canonical || canonical === value) return match;
      notes.push(`kind: "${value}" → "${canonical}"`);
      return `${prefix}${canonical}${trailing ?? ""}`;
    },
  );

  // 3. Pre-v1 node type aliases: code → function, intelligent → agent
  output = output.replace(
    /^(\s*(?:-\s*)?type\s*:\s*)(['"]?)(code|intelligent)(\2)(\s*(?:#.*)?)$/gm,
    (_match, prefix: string, q: string, value: string, q2: string, trailing: string) => {
      const next = NODE_TYPE_RENAMES[value]!;
      notes.push(`node type: "${value}" → "${next}"`);
      return `${prefix}${q}${next}${q2}${trailing ?? ""}`;
    },
  );
  output = output.replace(
    /(\btype\s*:\s*)(['"]?)(code|intelligent)(\2)(?=\s*[,}])/g,
    (_match, prefix: string, q: string, value: string, q2: string) => {
      const next = NODE_TYPE_RENAMES[value]!;
      notes.push(`node type: "${value}" → "${next}"`);
      return `${prefix}${q}${next}${q2}`;
    },
  );

  // 4. Pre-v1 hook events: intelligent:*ToolCall → agent:*ToolCall
  output = output.replace(
    /^(\s*(?:-\s*)?on\s*:\s*)(['"]?)(intelligent:(?:before|after)ToolCall)(\2)(\s*(?:#.*)?)$/gm,
    (_match, prefix: string, q: string, value: string, q2: string, trailing: string) => {
      const next = HOOK_EVENT_RENAMES[value]!;
      notes.push(`hook event: "${value}" → "${next}"`);
      return `${prefix}${q}${next}${q2}${trailing ?? ""}`;
    },
  );
  output = output.replace(
    /(\bon\s*:\s*)(['"]?)(intelligent:(?:before|after)ToolCall)(\2)(?=\s*[,}])/g,
    (_match, prefix: string, q: string, value: string, q2: string) => {
      const next = HOOK_EVENT_RENAMES[value]!;
      notes.push(`hook event: "${value}" → "${next}"`);
      return `${prefix}${q}${next}${q2}`;
    },
  );

  // 5. runtime.store → runtime.memory
  output = migrateRuntimeStore(output, notes);

  // 6. Skill front matter: kind_of → kindOf
  output = output.replace(
    /^(\s*)kind_of(\s*:)/gm,
    (_match, indent: string, colon: string) => {
      notes.push('skill front matter: "kind_of" → "kindOf"');
      return `${indent}kindOf${colon}`;
    },
  );

  const contracts = migrateDataContracts(output);
  output = contracts.output;
  notes.push(...contracts.notes);

  return { changed: output !== raw, output, notes, manual: contracts.manual };
}

function migrateRuntimeStore(raw: string, notes: string[]): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let inRuntime = false;
  let runtimeIndent = -1;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (trimmed && !trimmed.startsWith("#")) {
      if (indent === 0) {
        inRuntime = /^runtime\s*:/.test(trimmed);
        runtimeIndent = inRuntime ? 0 : -1;
      } else if (inRuntime && indent <= runtimeIndent) {
        inRuntime = false;
      }
    }

    if (inRuntime && indent > runtimeIndent) {
      const flowMatch = /^(\s*)store\s*:\s*\{([^}]*)\}(\s*(?:#.*)?)$/.exec(line);
      if (flowMatch) {
        const [, storeIndent, inner, trailing] = flowMatch;
        const disabled = /\benabled\s*:\s*false\b/.test(inner!) || /\bbackend\s*:\s*['"]?none['"]?\b/.test(inner!);
        if (disabled) {
          notes.push("runtime.store (disabled/none) removed");
        } else {
          const backendMatch = /\bbackend\s*:\s*['"]?([a-zA-Z0-9_-]+)['"]?/.exec(inner!);
          const rawBackend = backendMatch?.[1] ?? "memory";
          const nextBackend = rawBackend === "sqlite" || rawBackend === "postgres" ? "checkpoint" : "memory";
          notes.push(`runtime.store (backend: ${rawBackend}) → runtime.memory (backend: ${nextBackend})`);
          out.push(`${storeIndent}memory: { backend: ${nextBackend} }${trailing ?? ""}`);
        }
        i += 1;
        continue;
      }

      const blockMatch = /^(\s*)store\s*:(\s*(?:#.*)?)$/.exec(line);
      if (blockMatch) {
        const storeIndent = blockMatch[1]!;
        const trailing = blockMatch[2] ?? "";
        const blockLines: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j]!;
          const nextTrimmed = nextLine.trim();
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          if (nextTrimmed && !nextTrimmed.startsWith("#") && nextIndent <= storeIndent.length) break;
          blockLines.push(nextLine);
          j += 1;
        }
        let enabled = true;
        let rawBackend = "memory";
        const keptLines: string[] = [];
        for (const bl of blockLines) {
          const enMatch = /^\s*enabled\s*:\s*(true|false)\b/.exec(bl);
          if (enMatch) {
            enabled = enMatch[1] === "true";
            continue;
          }
          const bMatch = /^(\s*backend\s*:\s*)(['"]?)([a-zA-Z0-9_-]+)(\2)(\s*(?:#.*)?)$/.exec(bl);
          if (bMatch) {
            rawBackend = bMatch[3]!;
            const nextBackend =
              rawBackend === "sqlite" || rawBackend === "postgres" ? "checkpoint" : rawBackend;
            keptLines.push(`${bMatch[1]}${bMatch[2]}${nextBackend}${bMatch[4]}${bMatch[5] ?? ""}`);
            continue;
          }
          keptLines.push(bl);
        }
        if (!enabled || rawBackend === "none") {
          notes.push("runtime.store (disabled/none) removed");
        } else {
          const nextBackend =
            rawBackend === "sqlite" || rawBackend === "postgres" ? "checkpoint" : rawBackend;
          notes.push(`runtime.store (backend: ${rawBackend}) → runtime.memory (backend: ${nextBackend})`);
          out.push(`${storeIndent}memory:${trailing}`);
          const hasBackendLine = keptLines.some((l) => /^\s*backend\s*:/.test(l));
          if (!hasBackendLine) {
            out.push(`${storeIndent}  backend: ${nextBackend}`);
          }
          out.push(...keptLines);
        }
        i = j;
        continue;
      }
    }

    out.push(line);
    i += 1;
  }

  return out.join("\n");
}
