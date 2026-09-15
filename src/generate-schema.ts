import { writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CapabilityArtifactSchema } from "./schema/capability.js";

const jsonSchema = zodToJsonSchema(CapabilityArtifactSchema, "CapabilityArtifact");
writeFileSync("schema/capability.schema.json", `${JSON.stringify(jsonSchema, null, 2)}\n`);
