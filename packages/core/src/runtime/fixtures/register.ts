import { registerFunction } from "../../nodes/function.js";

/** Decoy: parent-relative `../register.ts` from a subgraph in a subfolder lands here. */
registerFunction("fromNestedSubgraphImport", () => ({ source: "parent-relative-decoy" }));
