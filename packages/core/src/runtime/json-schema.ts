import { ContractSchemaError, contractSchemaProblem } from "@flowgraph/spec";

export {
  validateJsonSchema,
  contractErrors,
  ContractSchemaError,
  type ValidateJsonSchemaOptions,
} from "@flowgraph/spec";

/** Fail the node (not the human's answer) when a rendered contract schema is invalid. */
export function assertContractSchema(schema: unknown, label: string): void {
  const problem = contractSchemaProblem(schema);
  if (problem) throw new ContractSchemaError(`${label}: invalid schema: ${problem}`);
}
