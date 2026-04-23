// Ambient module for @vantagesec/socc/engine.
//
// The socc engine bundle (dist/engine.mjs) exports `query` as an async
// generator, but its upstream types aren't shipped. We keep this shim
// deliberately loose — streamAdapter.ts projects runtime discriminants
// and doesn't need structural typing here.

declare module '@vantagesec/socc/engine' {
  export const query: (params: unknown) => AsyncIterable<unknown>
}
