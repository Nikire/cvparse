/**
 * Library version, injected at build time from `package.json` (see `tsup.config.ts` and
 * `vitest.config.ts`). When running straight from source with `tsx`, no value is injected
 * and this falls back to a dev marker.
 */
declare const __CVPARSE_VERSION__: string | undefined;

export const CVPARSE_VERSION: string =
  typeof __CVPARSE_VERSION__ === "string" ? __CVPARSE_VERSION__ : "0.0.0-dev";
