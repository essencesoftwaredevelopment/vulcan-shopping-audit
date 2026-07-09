/** Normalize user/pipeline-supplied domains to a bare registrable host: lowercase, no scheme/www/path/port. */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('://')) {
    try {
      s = new URL(s).hostname;
    } catch {
      // fall through with the raw string
    }
  }
  s = s.replace(/^www\./, '').split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(s)) return null;
  return s;
}
