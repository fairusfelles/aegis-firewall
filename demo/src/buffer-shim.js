// esbuild `inject` shim (see build.mjs). Some bundled libraries
// reference the Node-style global `Buffer`, which browsers do not
// provide. Injecting this file makes esbuild substitute the `buffer`
// package's export for every free `Buffer` reference in the bundle.
export { Buffer } from "buffer";
