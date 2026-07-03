/**
 * Sandboxed local filesystem tools for flowgraph intelligent nodes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { registerTool } from "@veloxdevworks/flowgraph-core";
import type { NodeRunContext } from "@veloxdevworks/flowgraph-core";
import { resolveSandboxPath, SandboxError } from "./sandbox.js";

export type FsOperation = "read" | "list" | "write" | "edit" | "delete";

export const MUTATING_FS_OPERATIONS: readonly FsOperation[] = ["write", "edit", "delete"];

export const DEFAULT_FS_OPERATIONS: readonly FsOperation[] = ["read", "list"];

export interface FsToolsOptions {
  /** Absolute path to the workspace root; all tool paths are resolved relative to this. */
  workspaceRoot: string;
  /** Which operations to register. Defaults to read + list only. */
  operations?: FsOperation[];
}

export interface FsToolsRegistration {
  registered: string[];
  workspaceRoot: string;
  operations: FsOperation[];
}

const readSchema = z.object({ path: z.string() });
const listSchema = z.object({ path: z.string().optional().default(".") });
const writeSchema = z.object({ path: z.string(), content: z.string() });
const editSchema = z.object({
  path: z.string(),
  find: z.string(),
  replace: z.string(),
});
const deleteSchema = z.object({ path: z.string() });

function audit(ctx: NodeRunContext, operation: FsOperation, filePath: string, extra?: Record<string, unknown>): void {
  ctx.emit("node.output", { fs: { operation, path: filePath, ...extra } });
}

/** Register filesystem tools scoped to `workspaceRoot`. */
export function registerFsTools(opts: FsToolsOptions): FsToolsRegistration {
  const workspaceRoot = path.resolve(opts.workspaceRoot);
  const operations = [...(opts.operations ?? DEFAULT_FS_OPERATIONS)];

  const registered: string[] = [];

  if (operations.includes("read")) {
    registerTool({
      name: "fs_read",
      description: "Read a text file relative to the graph workspace.",
      schema: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path to the file" } },
        required: ["path"],
      },
      handler: async (args, ctx) => {
        const { path: rel } = readSchema.parse(args);
        const abs = await resolveSandboxPath(workspaceRoot, rel);
        const content = await fs.readFile(abs, "utf8");
        audit(ctx, "read", rel, { bytes: Buffer.byteLength(content, "utf8") });
        return { path: rel, content };
      },
    });
    registered.push("fs_read");
  }

  if (operations.includes("list")) {
    registerTool({
      name: "fs_list",
      description: "List files in a directory relative to the graph workspace.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path (default: .)" },
        },
      },
      handler: async (args, ctx) => {
        const { path: rel } = listSchema.parse(args);
        const abs = await resolveSandboxPath(workspaceRoot, rel);
        const stat = await fs.stat(abs);
        if (!stat.isDirectory()) {
          throw new SandboxError(`Not a directory: ${rel}`);
        }
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const items = entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other",
        }));
        audit(ctx, "list", rel, { count: items.length });
        return { path: rel, entries: items };
      },
    });
    registered.push("fs_list");
  }

  if (operations.includes("write")) {
    registerTool({
      name: "fs_write",
      description: "Create or overwrite a text file relative to the graph workspace.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      handler: async (args, ctx) => {
        const { path: rel, content } = writeSchema.parse(args);
        const abs = await resolveSandboxPath(workspaceRoot, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
        audit(ctx, "write", rel, { bytes: Buffer.byteLength(content, "utf8") });
        return { path: rel, written: true };
      },
    });
    registered.push("fs_write");
  }

  if (operations.includes("edit")) {
    registerTool({
      name: "fs_edit",
      description: "Replace text in a file relative to the graph workspace.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          find: { type: "string" },
          replace: { type: "string" },
        },
        required: ["path", "find", "replace"],
      },
      handler: async (args, ctx) => {
        const { path: rel, find, replace } = editSchema.parse(args);
        const abs = await resolveSandboxPath(workspaceRoot, rel);
        const before = await fs.readFile(abs, "utf8");
        if (!before.includes(find)) {
          throw new SandboxError(`Text not found in ${rel}`);
        }
        const after = before.replace(find, replace);
        await fs.writeFile(abs, after, "utf8");
        audit(ctx, "edit", rel, { replacements: 1 });
        return { path: rel, edited: true };
      },
    });
    registered.push("fs_edit");
  }

  if (operations.includes("delete")) {
    registerTool({
      name: "fs_delete",
      description: "Delete a file relative to the graph workspace.",
      schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async (args, ctx) => {
        const { path: rel } = deleteSchema.parse(args);
        const abs = await resolveSandboxPath(workspaceRoot, rel);
        const stat = await fs.stat(abs);
        if (!stat.isFile()) {
          throw new SandboxError(`Not a file: ${rel}`);
        }
        await fs.unlink(abs);
        audit(ctx, "delete", rel);
        return { path: rel, deleted: true };
      },
    });
    registered.push("fs_delete");
  }

  return { registered, workspaceRoot, operations };
}

export { resolveSandboxPath, SandboxError } from "./sandbox.js";
