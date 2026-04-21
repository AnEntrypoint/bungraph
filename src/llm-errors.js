export class LLMError extends Error { constructor(msg, cause) { super(msg); this.name = this.constructor.name; this.cause = cause; } }
export class LLMTransientError extends LLMError {}
export class LLMTimeoutError extends LLMTransientError {}
export class LLMProcessError extends LLMError {}
export class LLMValidationError extends LLMError {}
export class LLMAbortError extends LLMError {}
export function isTransient(e) { return e instanceof LLMTransientError; }
