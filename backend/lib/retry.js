// Retry a promise-returning fn on transient failures (network / 429 / 5xx),
// with exponential backoff. Keeps momentary OpenAI hiccups from surfacing to
// the shopper as an error.
async function withRetry(fn, { retries = 2, baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      const retryable =
        status === undefined || status === 429 || (status >= 500 && status < 600) ||
        ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"].includes(e?.code);
      if (attempt === retries || !retryable) break;
      await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
