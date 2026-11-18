// Types for the generator, used by tests.
export function loadSpec(path?: string): any
export function schemaDefs(spec: any): Record<string, unknown>
export function createAjv(spec: any, options?: { source?: boolean }): any
export function loadDataPolicySchema(path?: string): any
export function createDataPolicyAjv(schema?: any, options?: { source?: boolean }): any
export function generate(spec?: any, dataPolicySchema?: any): Record<string, string>
