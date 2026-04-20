import { logger } from './logger.js';
import { register } from './debug-registry.js';

const log = logger.child('store.tx');

const state = {
  writerBusy: false,
  writerQueueLen: 0,
  txCommitted: 0,
  txRolledBack: 0,
  busyRetries: 0,
  lastError: null,
};

register('store.tx', () => ({ ...state }));

const waiters = [];

function acquireWriter() {
  if (!state.writerBusy) { state.writerBusy = true; return Promise.resolve(); }
  state.writerQueueLen++;
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseWriter() {
  const next = waiters.shift();
  if (next) { state.writerQueueLen--; next(); return; }
  state.writerBusy = false;
}

function isBusy(e) {
  const code = e?.code || e?.rawCode;
  if (code === 'SQLITE_BUSY' || code === 5 || code === 'SQLITE_LOCKED' || code === 6) return true;
  const msg = String(e?.message || '');
  return /SQLITE_BUSY|database is locked|SQLITE_LOCKED/i.test(msg);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function backoffDelay(attempt) {
  const base = 25 * Math.pow(2, attempt);
  const capped = Math.min(base, 2000);
  return capped * (0.5 + Math.random() * 0.5);
}

export async function withTx(db, fn, { maxAttempts = 8 } = {}) {
  await acquireWriter();
  try {
    let attempt = 0;
    for (;;) {
      const tx = await db.transaction('write');
      try {
        const out = await fn(tx);
        await tx.commit();
        state.txCommitted++;
        return out;
      } catch (e) {
        try { await tx.rollback(); } catch {}
        state.txRolledBack++;
        state.lastError = { msg: String(e?.message || e).slice(0, 200), code: e?.code, at: Date.now() };
        if (isBusy(e) && attempt < maxAttempts - 1) {
          state.busyRetries++;
          const d = backoffDelay(attempt);
          log.warn('tx busy, retrying', { attempt, delay_ms: Math.round(d) });
          await sleep(d);
          attempt++;
          continue;
        }
        throw e;
      }
    }
  } finally {
    releaseWriter();
  }
}

export async function withWriter(fn) {
  await acquireWriter();
  try { return await fn(); } finally { releaseWriter(); }
}

export function txStats() { return { ...state }; }
