import { DEFAULT_CONFIG } from '../../../src/engine/types';

/** The host seam of `buildAiToolRegistry` for tests that configure no analysis settings. */
export const TOOL_HOST = { analysisSettings: () => DEFAULT_CONFIG.analysis };
