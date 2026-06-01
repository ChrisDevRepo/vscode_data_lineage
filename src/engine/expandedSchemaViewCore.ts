/**
 * @module ExpandedSchemaViewCore
 * Backwards-compatible exports for expanded schema view partition/count helpers.
 *
 * The implementation lives in `schemaProjection`, the pure projection layer used by both
 * Schema View and Expanded Schema View.
 */

export {
  countExpandedSchemaViewRenderedNodes,
  partitionBySchema,
  type ExpandedSchemaViewRenderOptions,
  type ExpandedSchemaViewResult,
} from './schemaProjection';
