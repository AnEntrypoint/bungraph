const registry = new Map();

export function register(key, provider) {
  if (!key || typeof key !== 'string') throw new Error('debug-registry key must be string');
  if (typeof provider !== 'function') throw new Error('debug-registry provider must be function');
  registry.set(key, provider);
  return () => registry.delete(key);
}

export function unregister(key) { registry.delete(key); }

export function snapshot() {
  const out = {};
  for (const [k, fn] of registry) {
    try { out[k] = fn(); } catch (e) { out[k] = { error: e?.message || String(e) }; }
  }
  return { ts: new Date().toISOString(), pid: process.pid, uptime_s: Math.round(process.uptime()), memory_mb: Math.round(process.memoryUsage().rss / 1e6), subsystems: out };
}

export function keys() { return [...registry.keys()]; }
