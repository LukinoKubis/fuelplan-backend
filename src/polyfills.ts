// Railway's Node runtime resolved to 18.20.8 (per `engines.node: >=18.0.0`,
// its oldest matching default) which doesn't expose `File` as a global —
// that only happens automatically in Node 20+. expo-server-sdk pulls in
// undici, which crashes at require-time (ReferenceError: File is not
// defined) without it. `node:buffer` has had `File` since 18.13.0, just
// not wired up as a global before Node 20, so polyfill it from there.
//
// This must be the FIRST import in server.ts — ES module imports execute
// in source order on first encounter (despite bindings being "hoisted"),
// so this side effect needs to run before expo-server-sdk's import is
// evaluated, not just be textually first as a non-import statement.
import { File } from 'node:buffer'

if (typeof globalThis.File === 'undefined') {
  // @ts-expect-error — Node <20's lib.dom types don't know about this global
  globalThis.File = File
}
