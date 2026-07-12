import type { AuditPayload } from '@/lib/types';

type ContextLogo = {
  type?: string | null;
  mode?: string | null;
  url?: string | null;
};

export type BrandLogo = {
  url: string;
  alt: string;
};

/** Pick the best logo from Context.dev's logos array (light logo preferred). */
export function pickBrandLogo(logos: ContextLogo[] | null | undefined, brandTitle: string): BrandLogo | null {
  if (!Array.isArray(logos) || !logos.length) return null;

  const preferred =
    logos.find((logo) => logo?.type === 'logo' && logo?.mode === 'light' && logo?.url) ||
    logos.find((logo) => logo?.type === 'logo' && logo?.url) ||
    logos.find((logo) => logo?.url);

  if (!preferred?.url) return null;

  return {
    url: preferred.url,
    alt: `${brandTitle} logo`,
  };
}

function contextApiKey(): string | null {
  return process.env.CONTEXT_DEV_API_KEY || process.env.CONTEXT_API_KEY || null;
}

/** Fetch brand logo from Context.dev retrieve API. */
export async function fetchBrandLogo(domain: string, brandTitle?: string): Promise<BrandLogo | null> {
  const key = contextApiKey();
  if (!key) return null;

  try {
    const res = await fetch('https://api.context.dev/v1/brand/retrieve', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'by_domain', domain }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as Record<string, unknown>;
    const brand = (json.brand ?? json) as Record<string, unknown>;
    const title =
      brandTitle ||
      (typeof brand.title === 'string' && brand.title) ||
      (typeof brand.name === 'string' && brand.name) ||
      domain.split('.')[0];
    const logos = brand.logos as ContextLogo[] | undefined;

    return pickBrandLogo(logos, title);
  } catch {
    return null;
  }
}

/** Fill in logo_url when missing (best-effort, does not throw). */
export async function enrichBrandLogo<T extends AuditPayload['brand']>(brand: T): Promise<T> {
  if (brand.logo_url) return brand;
  const logo = await fetchBrandLogo(brand.domain, brand.name);
  if (!logo) return brand;
  return { ...brand, logo_url: logo.url, logo_alt: logo.alt };
}
