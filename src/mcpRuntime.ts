/**
 * Deferred MCP bundle entry (`out/mcpRuntime.js`).
 *
 * @remarks
 * `extensionRuntime.ts` imports this bundle at activation only while `dataLineageViz.mcp.enabled`
 * is on, so a disabled MCP server loads none of its code or SDK; the setting takes effect on the
 * next window reload, like the `dataLineageViz.ai.enabled` kill switch. A named export, because a
 * dynamic `import()` of a CommonJS bundle exposes `module.exports` itself as `default`.
 */
export { registerMcpServer } from './ai/mcp/mcpController';
