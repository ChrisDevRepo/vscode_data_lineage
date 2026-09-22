/** Type surface of `templateStructure.mjs` for the unit test that imports it under `tsc`. */
export type TemplateStructure = Record<string, Record<string, string>>;
export function templateStructure(text: string): TemplateStructure;
export function structureFingerprint(text: string): string;
export function structureDiff(before: TemplateStructure, after: TemplateStructure): string[];
