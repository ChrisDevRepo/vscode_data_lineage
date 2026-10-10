/**
 * The discovery file a running MCP endpoint publishes for the stdio proxy.
 *
 * @remarks
 * Written by the extension (user-only permissions) while the endpoint listens and removed when it
 * stops. The proxy is a separate process, so it reads the file as untrusted input through
 * {@link parseMcpDiscovery}. VS Code-free; written with `zod/mini` so the standalone proxy bundle
 * carries no more of Zod than this check needs.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod/mini';

/** Contract of the discovery file. */
const McpDiscoverySchema = z.strictObject({
  /** Streamable HTTP endpoint on `127.0.0.1`. */
  url: z.url({ protocol: /^http$/, hostname: /^127\.0\.0\.1$/ }),
  /** Bearer token the endpoint requires. */
  token: z.string().check(z.minLength(1)),
});

/** Parsed discovery file. */
export type McpDiscovery = z.infer<typeof McpDiscoverySchema>;

/**
 * Parses discovery file text.
 *
 * @returns The endpoint, or `null` when the text is not a valid discovery file.
 */
export function parseMcpDiscovery(text: string): McpDiscovery | null {
  try {
    const parsed = McpDiscoverySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Reads the discovery file at `path`.
 *
 * @returns The endpoint, or `null` while no endpoint runs or the file is unreadable or invalid.
 */
export function readMcpDiscoveryFile(path: string): McpDiscovery | null {
  try {
    return parseMcpDiscovery(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
