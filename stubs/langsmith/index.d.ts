/**
 * Types for the inert langsmith replacement (see index.js). Deliberately loose: nothing in
 * this project imports langsmith directly, so these exist only so `@langchain/core`'s type
 * references resolve without the real package.
 */
export declare const LANGSMITH_EXCLUDED: string;
export declare function isTraceableFunction(value: unknown): boolean;
export declare function getCurrentRunTree(): undefined;
export declare function isRunTree(value: unknown): boolean;
export declare function getDefaultProjectName(): string;
export declare function convertToDottedOrderFormat(...args: unknown[]): never;
export declare class Client {
  constructor(...args: unknown[]);
}
export declare class RunTree {
  constructor(fields?: Record<string, unknown>);
  extra: Record<string, unknown>;
  createChild(fields?: Record<string, unknown>): RunTree;
  end(): void;
  postRun(): Promise<never>;
  patchRun(): Promise<never>;
}
