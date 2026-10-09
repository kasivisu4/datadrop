// Should a large remote sample be cached in memory ("fast mode") or queried in place ("light mode")?
// Pure functions plus one reader of browser signals. No dependencies.

// Measured on the 5M-row chutes sample: the footer's compressed column sizes said 72 MB, the copy downloaded 105 MB
// (page headers, dictionaries, read-ahead), and DuckDB-WASM held it in 741 MiB.
export const DOWNLOAD_OVERHEAD = 1.45; // bytes actually read / compressed column sizes
export const MEMORY_EXPANSION = 7; // memory / bytes downloaded
// DuckDB-WASM is a 32-bit WebAssembly module: past ~2 GB a cache is likely to fail whatever the device has.
const WASM_CEILING_MB = 2000;

/**
 * Estimated download and memory (MB) for caching a sample, from the remote profile's compressed bytes per row.
 * columns: only these (a working set); default every column (fast mode).
 */
export function estimateSample(profile, columns) {
  const pick = columns ? (profile?.columns || []).filter((c) => columns.includes(c.name)) : (profile?.columns || []);
  const perRow = pick.reduce((n, c) => n + (c.bytesPerRow || 0), 0);
  const downloadMB = ((perRow * (profile?.rowCount || 0)) / 1e6) * DOWNLOAD_OVERHEAD;
  return { downloadMB, memoryMB: downloadMB * MEMORY_EXPANSION };
}

/**
 * Browser memory signals, each possibly missing:
 *   deviceMemoryGB  navigator.deviceMemory (Chromium; rounded, usually capped at 8)
 *   heapLimitMB     performance.memory.jsHeapSizeLimit (Chromium; JS heap, a hint of a 64-bit desktop browser)
 *   mobile          phone or tablet (userAgentData, else a coarse pointer without hover)
 * window.__memorySignals overrides them (tests, and checking the flow on another device class).
 */
export function readMemorySignals(w = globalThis) {
  if (w.__memorySignals) return { ...w.__memorySignals };
  const nav = w.navigator || {};
  const dm = Number(nav.deviceMemory);
  const heap = Number(w.performance?.memory?.jsHeapSizeLimit);
  let mobile = nav.userAgentData?.mobile;
  if (typeof mobile !== 'boolean') {
    try { mobile = !!w.matchMedia?.('(pointer: coarse) and (hover: none)').matches; } catch { mobile = false; }
  }
  return {
    deviceMemoryGB: dm > 0 ? dm : null,
    heapLimitMB: heap > 0 ? heap / 1048576 : null,
    mobile: !!mobile,
  };
}

/**
 * 'green'  cache automatically (fits comfortably)
 * 'yellow' ask first (fits, but it's a big share of memory, or the browser gives no signal)
 * 'red'    don't cache: light mode
 * Budgets are shares of device RAM: a tab shouldn't take more than ~15% without asking, or ~30% at all;
 * phones and tablets get half of that.
 */
export function memoryTier(memoryMB, { deviceMemoryGB = null, mobile = false } = {}) {
  if (!(memoryMB > 0)) return 'green';
  if (memoryMB > WASM_CEILING_MB) return 'red';
  const share = mobile ? 0.5 : 1;
  if (deviceMemoryGB) {
    const ram = deviceMemoryGB * 1024;
    if (memoryMB <= ram * 0.15 * share) return 'green';
    if (memoryMB <= ram * 0.3 * share) return 'yellow';
    return 'red';
  }
  // no signal (Firefox, Safari): desktops are asked; phones and tablets only for small samples
  if (mobile) return memoryMB <= 300 ? 'yellow' : 'red';
  return memoryMB <= 1500 ? 'yellow' : 'red';
}

/**
 * Most memory a working set may take in this browser (MB): the top of the "yellow" band (30% of RAM, half on mobile),
 * or the no-signal limits, and never past the WASM ceiling. Used by the memory-pressure guard.
 */
export function memoryBudgetMB({ deviceMemoryGB = null, mobile = false } = {}) {
  const budget = deviceMemoryGB ? deviceMemoryGB * 1024 * 0.3 * (mobile ? 0.5 : 1) : mobile ? 300 : 1500;
  return Math.min(budget, WASM_CEILING_MB);
}

/**
 * What to do given the user's preference ('ask' | 'fast' | 'light'):
 *   'auto' cache now, 'ask' offer it, 'light' stay light (reason: 'memory' or 'preference').
 * 'fast' still refuses red: past the budget the tab would likely crash.
 */
export function cacheDecision(tier, preference = 'ask') {
  if (preference === 'light') return { action: 'light', reason: 'preference' };
  if (tier === 'red') return { action: 'light', reason: 'memory' };
  if (tier === 'green' || preference === 'fast') return { action: 'auto' };
  return { action: 'ask' };
}
