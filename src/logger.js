const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 100 };
const SECRET_KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_SECRET_ACCESS_KEY', 'GCP_SERVICE_ACCOUNT']);
const REDACT_FIELDS = new Set(['authorization', 'apikey', 'api_key', 'token', 'secret', 'password', 'anthropic_api_key', 'bearer']);

function currentLevel() {
  const raw = (process.env.BUNGRAPH_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

function redactString(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const k of SECRET_KEYS) {
    const v = process.env[k];
    if (v && v.length >= 6) out = out.split(v).join('[REDACTED]');
  }
  return out;
}

function redactFields(v) {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? redactString(v) : v;
  if (Array.isArray(v)) return v.map(redactFields);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = REDACT_FIELDS.has(k.toLowerCase()) ? '[REDACTED]' : redactFields(val);
  }
  return out;
}

function emit(subsystem, level, msg, fields) {
  if (LEVELS[level] < currentLevel()) return;
  const rec = {
    ts: new Date().toISOString(),
    level,
    subsystem,
    msg: redactString(String(msg ?? '')),
    ...(fields ? { fields: redactFields(fields) } : {}),
  };
  const line = JSON.stringify(rec);
  process.stderr.write(line + '\n');
}

export function makeLogger(subsystem) {
  const base = { subsystem: String(subsystem || 'root') };
  const api = {
    trace: (m, f) => emit(base.subsystem, 'trace', m, f),
    debug: (m, f) => emit(base.subsystem, 'debug', m, f),
    info: (m, f) => emit(base.subsystem, 'info', m, f),
    warn: (m, f) => emit(base.subsystem, 'warn', m, f),
    error: (m, f) => emit(base.subsystem, 'error', m, f),
    child: (sub) => makeLogger(`${base.subsystem}.${sub}`),
  };
  return api;
}

export const logger = makeLogger('bungraph');
export { LEVELS, SECRET_KEYS, REDACT_FIELDS, redactFields, redactString };
