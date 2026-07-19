/** Minimal tool shape accepted from the VS Code LM registry. */
export interface RegistryToolLike {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly tags?: readonly string[];
}

/** Model-facing tool shape after phase- and repair-specific schema projection. */
export interface ProjectedCopilotTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolSchemaProjectionOptions {
  activePhase: 'discover' | 'active' | 'synthesis' | 'completed';
  isCtMode: boolean;
  hasHeldFinding: boolean;
  presentResultRepairFields: readonly string[];
}

function asSchema(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? structuredClone(value) as Record<string, unknown>
    : undefined;
}

function projectRepairSchema(
  schema: Record<string, unknown>,
  allowedFields: readonly string[],
  description: string,
): Record<string, unknown> {
  const fullProps = schema.properties as Record<string, unknown> | undefined;
  schema.properties = {
    repair: { type: 'boolean', const: true, description },
    ...Object.fromEntries(allowedFields
      .filter(key => fullProps?.[key] !== undefined)
      .map(key => [key, fullProps![key]])),
  };
  schema.required = ['repair'];
  schema.additionalProperties = false;
  return schema;
}

/**
 * Projects registry tools into the exact schemas sent for one Copilot request.
 * The function is intentionally VS Code-free so repair/schema behavior is unit-testable.
 */
export function projectCopilotTools(
  registryTools: readonly RegistryToolLike[],
  options: ToolSchemaProjectionOptions,
): ProjectedCopilotTool[] {
  return registryTools.map(tool => {
    let inputSchema = asSchema(tool.inputSchema);

    if (options.isCtMode && tool.name === 'lineage_submit_findings' && inputSchema) {
      const props = inputSchema.properties as Record<string, unknown> | undefined;
      if (props) delete props.prune_neighbors;
    }

    if (options.activePhase === 'active' && tool.name === 'lineage_submit_findings' && options.hasHeldFinding && inputSchema) {
      inputSchema = projectRepairSchema(
        inputSchema,
        options.isCtMode ? ['route_requests', 'column_flow'] : ['route_requests', 'prune_neighbors'],
        'Required. Apply only the rejected fields to the held finding for this unchanged focus.',
      );
    }

    // Phase-independent: the server enforces the patch schema whenever a repairable draft is
    // held (synthesis OR completed follow-up), so the projection must match wherever repair
    // fields are authorized — not only in synthesis.
    if (tool.name === 'lineage_present_result' && options.presentResultRepairFields.length > 0 && inputSchema) {
      inputSchema = projectRepairSchema(
        inputSchema,
        options.presentResultRepairFields,
        'Required. Patch only the rejected fields of the held presentation draft.',
      );
    }

    return {
      name: tool.name,
      description: tool.description || (tool.tags?.includes('lineage-presentation') ? 'Presents results to user' : 'Lineage tool'),
      inputSchema,
    };
  });
}
