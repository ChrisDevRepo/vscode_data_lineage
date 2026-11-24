import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';

/**
 * The host seam of `buildAiToolRegistry` for tests that model a chat turn and configure no analysis
 * settings: the shipped turn budget. A test that models the MCP server passes `budget: null`.
 */
export const TOOL_HOST = { analysisSettings: () => DEFAULT_CONFIG.analysis, budget: DEFAULT_TURN_TOKEN_BUDGET };
