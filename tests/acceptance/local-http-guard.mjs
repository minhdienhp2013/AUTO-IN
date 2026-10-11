// HTTP smoke testing is local-only. Never point at a production store.
export function assertLocalSimulationUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw Error('AUTOIN_API_URL required');
  let url;
  try { url = new URL(raw); } catch { throw Error('Invalid AUTOIN_API_URL'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw Error('Only localhost HTTP is allowed; no live OA/printer traffic');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('Provide a clean localhost origin without credentials/path/query');
  }
  if (process.env.AUTOIN_ACCEPTANCE_HTTP_SCOPE !== 'local-simulation') {
    throw Error('Set AUTOIN_ACCEPTANCE_HTTP_SCOPE=local-simulation explicitly');
  }
  return url.origin;
}
