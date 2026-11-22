import { z } from "zod";
import { registerGraphExtensionSchema, strictObject } from "@flowgraph/spec";

export const FsOperationSchema = z.enum(["read", "list", "write", "edit", "delete"]);
export type FsOperation = z.infer<typeof FsOperationSchema>;

export const LocalToolsFsSchema = strictObject({
  workspaceRoot: z.string().optional().default("."),
  operations: z.array(FsOperationSchema).optional(),
});
export type LocalToolsFs = z.infer<typeof LocalToolsFsSchema>;

export const LocalToolsSchema = strictObject({
  fs: LocalToolsFsSchema.optional(),
});
export type LocalTools = z.infer<typeof LocalToolsSchema>;

/** Register the top-level `localTools` graph spec extension (idempotent). */
export function registerLocalToolsSchema(): void {
  registerGraphExtensionSchema("localTools", LocalToolsSchema);
}
