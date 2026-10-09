// UI test stub for src/agents/llm.js
export function createLLM(opts) {
  return { opts, async complete() { return 'stub'; }, async completeJSON() { return {}; } };
}
