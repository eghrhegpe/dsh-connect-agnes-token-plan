/**
 * Ambient types for Host-runtime-provided peer modules.
 *
 * DSH ships the private @deepseek-ai/* scope with the runtime itself; the local
 * npm mirror cannot install it (see docs/CONTRIBUTING.md §8 on the registry),
 * so this checkout's node_modules has no copy to resolve types from. These
 * declarations assert only the module's EXISTENCE so that @ts-check can resolve
 * the specifier without pretending to know the real shape — the runtime shape
 * is the authority, exactly as with the peer-only test suites.
 *
 * Dev-only: package.json#files does not include types/, so nothing here ships
 * in the tarball. Keep entries in sync with the peer imports actually in *.js.
 */
declare module "@deepseek-ai/dsh-tools";
