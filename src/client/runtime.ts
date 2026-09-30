/**
 * The React seam.
 *
 * The loader materializes `clientFactory(loaderRequire)` with the browser
 * module table's own React — the client never imports a React package, and
 * the Node suites hand the factory a recording stand-in instead. Every other
 * module reads React through here: `provideClientReact` runs once at factory
 * entry, and the forwarded `h`/hooks below resolve through it at render time.
 *
 * Call sites stay identical to the pre-split closure form (`h("div", ...)`,
 * `useState(...)`), so the components are transcriptions, not rewrites.
 *
 * The factory parameter is named `loaderRequire` — NOT `require` — on purpose:
 * a bare `require("react")` in bundled ESM is module-system syntax as far as a
 * bundler is concerned (it may rewrite or resolve it); any other identifier is
 * verifiably a plain parameter call and survives the bundle untouched.
 */

/** Minimal structural view of the React API the client actually uses. */
export interface ReactApi {
  createElement: H;
  useState: <S>(initial: S | (() => S)) => [S, (value: S | ((prev: S) => S)) => void];
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void;
  useCallback: <F extends (...args: never[]) => unknown>(callback: F, deps: unknown[]) => F;
  useMemo: <T>(factory: () => T, deps: unknown[]) => T;
  useRef: <T>(initial: T) => { current: T };
}

/** createElement's face: element trees are untyped here, as in the original. */
export type H = (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;

/** The dictionary lookup face every component receives as `tt`. */
export type Tt = (key: string) => string;

let api: ReactApi | null = null;

/** Hand the loader-provided React to the rest of the client. One-shot. */
export function provideClientReact(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("client: the loader did not hand over a react module");
  }
  api = value as ReactApi;
}

function reactApi(): ReactApi {
  if (api === null) throw new Error("client: react used before clientFactory ran");
  return api;
}

export const h: H = (type, props, ...children) => reactApi().createElement(type, props, ...children);

export const useState: ReactApi["useState"] = (initial) => reactApi().useState(initial);

export const useEffect: ReactApi["useEffect"] = (effect, deps) => reactApi().useEffect(effect, deps);

export const useCallback: ReactApi["useCallback"] = (callback, deps) => reactApi().useCallback(callback, deps);

export const useMemo: ReactApi["useMemo"] = (factory, deps) => reactApi().useMemo(factory, deps);

export const useRef: ReactApi["useRef"] = (initial) => reactApi().useRef(initial);
