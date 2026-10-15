import { register } from "node:module";

// Node-only component tests: preserve CSS class identity without a browser loader.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true,
      source: 'export default new Proxy({}, { get: (_target, name) => String(name) });' };
    return nextLoad(url, context);
  }
`)}`, import.meta.url);
