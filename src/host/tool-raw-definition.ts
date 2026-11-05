/**
 * Raw agent-tool definition — the fallback for Hosts without the tools peer.
 *
 * The plugin's two agent tools are built through the peer's `defineTool`
 * (`@deepseek-ai/dsh-tools`). A peer import is a **file-location** resolution:
 * Node walks the plugin directory's own ancestors for a matching
 * `node_modules`, and installs under `~/.dsh/plugins` never contain the Host
 * runtime (the CLI runtime lives under a global npm prefix; the desktop
 * runtime lives inside the app bundle). On those hosts the peer load throws
 * `ERR_MODULE_NOT_FOUND` every single time — the tools were silently absent
 * forever, even with the switch visibly on (docs/TOOL-HOT-RELOAD.md §2.2).
 *
 * Sibling plugin workbuddy solves it by hand-writing plain `ToolDefinition`
 * objects (src/image-tool.ts): the Host's `tools.register` only needs
 * `name` / `description` / `parameters` / `output.render` and **projects
 * `parameters` verbatim** to the model — it does not validate arguments
 * itself. So this module reproduces the conversion the peer would have done,
 * faithful to the peer library (verified against
 * dsh-tools lib/index.js: runSchemaCompiler :586-754, compilePropertyMap
 * :756-769, parameterSchemaSpecToJsonSchema :802-811, defineTool :838-887):
 *
 *   - author-spec property map → `{ type: "object", properties }`, with the
 *     root `required` array emitted ONLY when at least one property declared
 *     `required: true` (the peer's property-map-tail skips it when empty);
 *     the per-property `required` flag is stripped from the property;
 *   - each property node keeps ONLY the keys the peer's schema DSL allows:
 *     annotations (`description` / `title` / `default` / `examples` — the
 *     peer's ANNOTATION_KEYS) plus type-specific structure
 *     (`enum` / `const` for scalars, `items` for arrays,
 *     `properties` / `additionalProperties` for objects); anything else —
 *     `minLength`, `pattern`, `$schema` — is dropped, mirroring the peer's
 *     `assertAuthorKeys` (which would reject the whole spec outright —
 *     throwing here would degrade the mount to absence, so a foreign key
 *     costs one annotation at most, never the tool);
 *   - `type: "json"` (author-only) projects to an annotation-only node: `{}`
 *     plus annotations — the peer's json case keeps nothing else;
 *   - `output.schema` passes through as-is: both tools already declare real
 *     JSON Schema shapes there and the peer's value compiler preserves the
 *     subset they use (type / properties / required / additionalProperties /
 *     description);
 *   - `timeoutMs` keeps the peer's contract — positive finite or the key is
 *     omitted (the peer THROWS on a bad value; omitting instead of throwing
 *     matches "degrade, never crash").
 *
 * The peer's argument pre-validation (`ToolArgsError` on a bad shape) is NOT
 * replicated: the host never enforced it either, and both tools already run
 * their own strict gate first (`validateDrawArgs`; the video tool checks
 * `prompt` in `execute`), so falling back loses no behavior the plugin relied
 * on — the strict gate IS the fence on every host form.
 *
 * Peer-free discipline: importing NOTHING from `@deepseek-ai/*` is the point —
 * this file must work on every host form.
 *
 * @module dsh-connect-agnes-token-plan/tool-raw-definition
 */

/** A JSON-ish value: the shapes our tools' specs are made of. */
type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

/** The peer's annotation vocabulary (lib/index.js ANNOTATION_KEYS). */
const ANNOTATION_KEYS: readonly string[] = ["description", "title", "default", "examples"];

/** Per-property entries of an author spec (the shape defineDrawTool passes). */
type PropertySpec = { [key: string]: JsonLike };

/** The author-spec parameter map: property name -> spec. */
export type ParameterSpecMap = { [key: string]: PropertySpec | undefined };

/** The options bag the factories hand to `defineTool` (peer or raw fallback). */
export type ToolDefinitionOptions = {
  name: string;
  description?: string;
  parameters?: ParameterSpecMap;
  output?: { schema?: JsonLike; render?: (args: JsonLike, value: JsonLike) => string };
  timeoutMs?: number;
  execute?: (args: JsonLike, exec: unknown) => Promise<JsonLike>;
};

/** The raw schema projection of one author node, peer key vocabulary only. */
function compileValueNode(spec: PropertySpec): { [key: string]: JsonLike } {
  const node: { [key: string]: JsonLike } = {};
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(spec, key)) node[key] = spec[key] as JsonLike;
  }
  switch (spec.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      node.type = spec.type;
      if (Array.isArray(spec.enum)) node.enum = spec.enum.slice();
      if (Object.hasOwn(spec, "const")) node.const = spec.const as JsonLike;
      break;
    case "array":
      node.type = "array";
      {
        const items = spec.items;
        if (items && typeof items === "object" && !Array.isArray(items)) {
          node.items = compileValueNode(items as PropertySpec);
        }
      }
      break;
    case "object": {
      node.type = "object";
      if (typeof spec.additionalProperties === "boolean") {
        node.additionalProperties = spec.additionalProperties;
      }
      const props = spec.properties;
      if (props && typeof props === "object" && !Array.isArray(props)) {
        const map = props as { [key: string]: PropertySpec };
        const compiled: { [key: string]: JsonLike } = {};
        const required: string[] = [];
        for (const key of Object.keys(map)) {
          const entry = map[key];
          if (!entry || typeof entry !== "object") continue;
          compiled[key] = compileValueNode(entry);
          if (entry.required === true) required.push(key);
        }
        node.properties = compiled;
        if (required.length > 0) node.required = required;
      }
      break;
    }
    case "json":
      // Author-only node: the peer keeps annotations and no type (any JSON).
      break;
    default:
      // Unknown/absent type: the peer would reject the spec outright. Emit an
      // annotation-only node — an unconstrained argument shape beats a tool
      // that never mounted (both tools validate strictly in execute anyway).
      break;
  }
  return node;
}

/**
 * Convert an author-spec property map to the JSON Schema the peer emits:
 * `{ type: "object", properties, required? }` — the root `required` array
 * appears ONLY when some property declared `required: true` (the peer's
 * property-map-tail skips an empty list).
 */
export function parameterSpecsToJsonSchema(parameters: ParameterSpecMap): { [key: string]: JsonLike } {
  const properties: { [key: string]: JsonLike } = {};
  const required: string[] = [];
  for (const key of Object.keys(parameters)) {
    const spec = parameters[key];
    if (!spec || typeof spec !== "object") continue;
    properties[key] = compileValueNode(spec);
    if (spec.required === true) required.push(key);
  }
  return required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties };
}

/** Mirror the peer's timeoutMs contract: positive finite, else omitted. */
export function rawTimeoutMs(timeoutMs: number | undefined): { timeoutMs?: number } {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {};
}

/**
 * The plain `ToolDefinition` shape the host's `tools.register` consumes: the
 * peer's contract minus the peer. `parameters` is a JSON Schema object here
 * (the factories' input spec map is converted at build time).
 */
export type RawToolDefinition = {
  name: string;
  description?: string;
  parameters?: { [key: string]: JsonLike };
  output?: { schema?: JsonLike; render?: (args: JsonLike, value: JsonLike) => string };
  timeoutMs?: number;
  execute?: (args: JsonLike, exec: unknown) => Promise<JsonLike>;
};

/**
 * `defineTool` stand-in for Hosts where the tools peer cannot load: builds a
 * plain `ToolDefinition` from the same options the factories already pass.
 * Unknown extra option keys are dropped (neither tool uses one today).
 */
export function rawDefineTool(options: ToolDefinitionOptions): RawToolDefinition {
  const definition: RawToolDefinition = {
    name: options.name,
    ...options.description !== undefined ? { description: options.description } : {},
    ...options.parameters ? { parameters: parameterSpecsToJsonSchema(options.parameters) } : {},
    ...options.output ? { output: options.output } : {},
    ...rawTimeoutMs(options.timeoutMs),
    ...options.execute ? { execute: options.execute } : {}
  };
  return definition;
}
