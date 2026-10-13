import { describe, it, expect } from 'vitest';
import { ExtensionToWebviewMsgSchema, validateBridgeFrame, BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';

describe('bridge parseStats schema validation', () => {
  it('validates spDetails strictly and correctly', () => {
    const validMessage = {
      type: 'db-model',
      sourceName: 'test',
      config: { showExcludedNodes: false, layoutOrientation: 'TB' },
      model: {
        nodes: [],
        edges: [],
        schemas: [],
        neighborIndex: {},
        catalog: {},
        parseStats: {
          objects: 1,
          lines: 10,
          parsedRefs: 2,
          resolvedEdges: 2,
          droppedRefs: [],
          spDetails: [{
            name: 'test_sp',
            inCount: 1,
            outCount: 1,
            inRefs: [],
            outRefs: [],
            unrelated: [],
            excluded: []
          }]
        }
      }
    };

    const validResult = validateBridgeFrame(ExtensionToWebviewMsgSchema, { ...validMessage, protocolVersion: BRIDGE_PROTOCOL_VERSION });
    expect(validResult.ok).toBe(true);

    const invalidMessage = {
      type: 'db-model',
      sourceName: 'test',
      config: { showExcludedNodes: false, layoutOrientation: 'TB' },
      model: {
        nodes: [],
        edges: [],
        schemas: [],
        neighborIndex: {},
        catalog: {},
        parseStats: {
          objects: 1,
          lines: 10,
          parsedRefs: 2,
          resolvedEdges: 2,
          droppedRefs: [],
          spDetails: [{
            name: 'test_sp',
            inCount: 1,
            outCount: 1,
            unrelated: [],
            extraProp: 'should-fail' // strict() should reject this
          }]
        }
      }
    };

    const invalidResult = validateBridgeFrame(ExtensionToWebviewMsgSchema, { ...invalidMessage, protocolVersion: BRIDGE_PROTOCOL_VERSION });
    expect(invalidResult.ok).toBe(false);
  });
});
