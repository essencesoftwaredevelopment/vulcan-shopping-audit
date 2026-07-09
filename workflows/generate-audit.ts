import { FatalError } from 'workflow';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { svc } from '@/lib/supabase';
import type { AuditCompetitor, AuditFinding, AuditPayload } from '@/lib/types';

/**
 * Audit generation agent. Triggered per prospect domain when they reply positively
 * (10–20 runs/day). Assembles the audit from data the outbound pipeline already
 * computed (hero_selections, shopify_snapshots, ad_observations, signal_emissions,
 * job_serper_shopping_cache), researches anything missing live (products.json,
 * Serper shopping), generates improved copy + a standout image, and upserts one
 * shopping_audits row that the static page hydrates from.
 */
export async function generateAudit(domain: string) {
  'use workflow';

  await setStatus(domain, 'generating');
  try {
    const research = await gatherResearch(domain);
    const copy = await composeCopy(research);
    const afterImgUrl = await createAfterImage(research);
    await finalizeAudit(research, copy, afterImgUrl);
  } catch (err) {
    await setFailed(domain, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step payloads (must be JSON-serializable — no Buffers across step boundaries)
// ---------------------------------------------------------------------------

type ShoppingCard = {
  title?: string | null;
  price?: string | null;
  priceValue?: number | null;
  rating?: number | null;
  ratingCount?: number | null;
  seller?: string | null;
  imageUrl?: string | null;
  link?: string | null;
};

type Hero = {
  title: string;
  handle: string | null;
  imageUrl: string | null;
  price: number | null;
  compareAt: number | null;
  vendor: string | null;
};

type Research = {
  domain: string;
  brandName: string;
  hero: Hero;
  productCount: number | null;
  aov: number | null;
  reviewSignals: { rating: number | null; count: number | null };
  matchedCard: ShoppingCard | null;
  allCards: ShoppingCard[];
  queryText: string | null;
  signals: { id: number; signal_type: string; tier: number | null; observed: unknown; expected: unknown }[];
  sourceRefs: Record<string, unknown>;
};

type Copy = { improved_title: string; search_term: string; findings: AuditFinding[] };

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function setStatus(domain: string, status: 'generating') {
  'use step';
  await svc()
    .from('shopping_audits')
    .upsert({ domain_normalized: domain, status }, { onConflict: 'domain_normalized' });
}

async function setFailed(domain: string, message: string) {
  'use step';
  await svc()
    .from('shopping_audits')
    .upsert(
      { domain_normalized: domain, status: 'failed', error_message: message.slice(0, 500) },
      { onConflict: 'domain_normalized' },
    );
}

/** Read everything the pipeline already knows, then fill gaps with live research. */
async function gatherResearch(domain: string): Promise<Research> {
  'use step';
  const sb = svc();

  const { data: heroSel } = await sb
    .from('hero_selections')
    .select('id, shopify_snapshot_id')
    .eq('domain_normalized', domain)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let snapshot: {
    id: number;
    handle: string | null;
    title: string | null;
    variants: unknown;
    review_signals: unknown;
  } | null = null;
  if (heroSel?.shopify_snapshot_id) {
    snapshot = (
      await sb
        .from('shopify_snapshots')
        .select('id, handle, title, variants, review_signals')
        .eq('id', heroSel.shopify_snapshot_id)
        .maybeSingle()
    ).data;
  }
  if (!snapshot) {
    snapshot = (
      await sb
        .from('shopify_snapshots')
        .select('id, handle, title, variants, review_signals')
        .eq('domain_normalized', domain)
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    ).data;
  }

  const { data: heroIds } = await sb
    .from('hero_selections')
    .select('id')
    .eq('domain_normalized', domain);

  let adObs: {
    id: number;
    matched_card: ShoppingCard | null;
    all_cards: ShoppingCard[] | null;
    query_text: string | null;
  } | null = null;
  if (heroIds && heroIds.length) {
    adObs = (
      await sb
        .from('ad_observations')
        .select('id, matched_card, all_cards, query_text')
        .in('hero_selection_id', heroIds.map((r) => r.id))
        .order('observed_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    ).data;
  }

  const { data: signals } = await sb
    .from('signal_emissions')
    .select('id, signal_type, tier, observed, expected')
    .eq('domain_normalized', domain)
    .order('observed_at', { ascending: false })
    .limit(12);

  const { data: serperCache } = await sb
    .from('job_serper_shopping_cache')
    .select('payload')
    .eq('domain_normalized', domain)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Live store fetch — audits are generated minutes before send, so pull fresh
  // prices, images and catalog size instead of trusting the snapshot.
  const live = await fetchShopifyStore(domain, snapshot?.handle ?? null);

  const hero: Hero | null =
    live?.hero ??
    (snapshot
      ? {
          title: snapshot.title ?? domain,
          handle: snapshot.handle,
          imageUrl: null,
          price: firstVariantNumber(snapshot.variants, 'price'),
          compareAt: firstVariantNumber(snapshot.variants, 'compare_at_price'),
          vendor: null,
        }
      : null);

  if (!hero) {
    throw new FatalError(
      `No product data for ${domain}: store unreachable/not Shopify and no snapshot on file`,
    );
  }

  const matchedCard = adObs?.matched_card ?? null;
  let allCards: ShoppingCard[] = Array.isArray(adObs?.all_cards) ? adObs.all_cards : [];
  const cachedCards = extractSerperCards(serperCache?.payload);
  allCards = allCards.concat(cachedCards);

  let queryText = adObs?.query_text ?? null;
  if (queryText) {
    queryText = queryText.replace(new RegExp(`^${domain.replace(/\./g, '\\.')}\\s*`, 'i'), '').trim() || null;
  }

  if (allCards.length < 4 && process.env.SERPER_API_KEY) {
    const q = queryText || genericQuery(hero.title);
    allCards = allCards.concat(await serperShopping(q));
  }

  return {
    domain,
    brandName: pickBrandName(domain, hero.vendor, matchedCard?.seller ?? null),
    hero,
    productCount: live?.productCount ?? null,
    aov: live?.aov ?? hero.price ?? null,
    reviewSignals: extractReviewSignals(snapshot?.review_signals),
    matchedCard,
    allCards: allCards.slice(0, 12),
    queryText,
    signals: (signals ?? []).map((s) => ({
      id: s.id,
      signal_type: s.signal_type,
      tier: s.tier,
      observed: s.observed,
      expected: s.expected,
    })),
    sourceRefs: {
      hero_selection_id: heroSel?.id ?? null,
      shopify_snapshot_id: snapshot?.id ?? null,
      ad_observation_id: adObs?.id ?? null,
      signal_ids: (signals ?? []).map((s) => s.id),
      used_serper_cache: cachedCards.length > 0,
      fetched_live_store: Boolean(live),
    },
  };
}

/** Improved title + findings copy, grounded in the research. Template fallback without an API key. */
async function composeCopy(research: Research): Promise<Copy> {
  'use step';
  const fallback = templateCopy(research);
  if (!process.env.ANTHROPIC_API_KEY) return fallback;

  const anthropic = new Anthropic();
  const evidence = {
    domain: research.domain,
    brand: research.brandName,
    hero_product: {
      title: research.hero.title,
      price: research.hero.price,
      compare_at_price: research.hero.compareAt,
    },
    live_shopping_ad: research.matchedCard,
    review_signals: research.reviewSignals,
    detected_signals: research.signals.map((s) => ({
      type: s.signal_type,
      observed: s.observed,
      expected: s.expected,
    })),
    search_query_seen: research.queryText,
  };

  const msg = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    max_tokens: 1200,
    system: [
      'You write copy for a Google Shopping ad audit page shown to an e-commerce founder about THEIR OWN store. Tone: sharp, concrete, no fluff — mirror this style: "The ad shows $66.95, the store charges $74.97. Google can disapprove it, and shoppers feel baited and bounce."',
      'Ground every claim in the evidence JSON. Never invent prices, ratings, or facts about the CURRENT ad/store. Use real numbers from the evidence when present.',
      'Return ONLY a JSON object, no markdown fences, with this exact shape:',
      '{"improved_title": string (Google Shopping product title, brand first, key attributes front-loaded, <=70 chars), "search_term": string (2-4 word shopping query a buyer would type, lowercase), "findings": [exactly 4 items: {"icon": one of "sell"|"star"|"image"|"local_offer"|"title"|"visibility_off", "title": <=28 chars, "body": <=150 chars}]}',
      'Findings = the 4 biggest problems with their current shopping ad, most damaging first, each grounded in a detected signal or visible gap (price mismatch, missing stars, weak title, flat image, no sale/shipping badge).',
    ].join('\n'),
    messages: [{ role: 'user', content: JSON.stringify(evidence) }],
  });

  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const parsed = extractJson(text);
  if (!parsed || typeof parsed.improved_title !== 'string' || !Array.isArray(parsed.findings) || parsed.findings.length < 4) {
    // A model formatting miss is not made more reliable by retrying the workflow.
    // Keep the audit moving with the deterministic, evidence-grounded copy.
    console.warn('Anthropic returned malformed audit copy; using template fallback');
    return fallback;
  }

  const ICONS = new Set(['sell', 'star', 'image', 'local_offer', 'title', 'visibility_off']);
  const findings: AuditFinding[] = parsed.findings.slice(0, 4).map((f: Record<string, unknown>, i: number) => ({
    icon: typeof f?.icon === 'string' && ICONS.has(f.icon) ? f.icon : fallback.findings[i].icon,
    title: (typeof f?.title === 'string' && f.title.trim().slice(0, 40)) || fallback.findings[i].title,
    body: (typeof f?.body === 'string' && f.body.trim().slice(0, 200)) || fallback.findings[i].body,
  }));

  return {
    improved_title: parsed.improved_title.trim().slice(0, 120) || fallback.improved_title,
    search_term:
      (typeof parsed.search_term === 'string' && parsed.search_term.trim().toLowerCase().slice(0, 60)) ||
      fallback.search_term,
    findings,
  };
}

/**
 * Standout "after" image: restyle the hero product photo with an image model,
 * compress to webp, upload to the public audit-assets bucket. Falls back to the
 * original photo when no GEMINI_API_KEY or generation fails; returns null when
 * there is no source image at all (page then reuses the before image).
 */
async function createAfterImage(research: Research): Promise<string | null> {
  'use step';
  const src = research.hero.imageUrl ?? research.matchedCard?.imageUrl ?? null;
  if (!src) return null;

  let original: Buffer;
  let mime = 'image/jpeg';
  try {
    const res = await fetchWithTimeout(src, 15000);
    if (!res.ok) return null;
    mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    original = Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }

  let out = original;
  const key = process.env.GEMINI_API_KEY;
  if (key) {
    try {
      const generated = await geminiRestyle(original, mime, key);
      if (generated) out = generated;
    } catch {
      // Generation is best-effort; the optimized original still beats nothing.
    }
  }

  const webp = await sharp(out)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  const sb = svc();
  const path = `${research.domain}/after.webp`;
  const body = new Blob([webp], { type: 'image/webp' });
  const { error } = await sb.storage
    .from('audit-assets')
    .upload(path, body, { contentType: 'image/webp', upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return sb.storage.from('audit-assets').getPublicUrl(path).data.publicUrl;
}

/** Assemble the page payload and mark the audit ready. */
async function finalizeAudit(research: Research, copy: Copy, afterImgUrl: string | null) {
  'use step';
  const payload = buildPayload(research, copy, afterImgUrl);
  const { error } = await svc()
    .from('shopping_audits')
    .upsert(
      {
        domain_normalized: research.domain,
        status: 'ready',
        payload,
        payload_version: 1,
        error_message: null,
        source_refs: research.sourceRefs,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'domain_normalized' },
    );
  if (error) throw new Error(`Failed to store audit: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

function buildPayload(research: Research, copy: Copy, afterImgUrl: string | null): AuditPayload {
  const { domain, hero, matchedCard } = research;

  const beforeImg = matchedCard?.imageUrl ?? hero.imageUrl ?? '';
  const before = {
    img: beforeImg,
    title: matchedCard?.title || hero.title,
    price: priceString(matchedCard?.price, matchedCard?.priceValue ?? hero.price),
    store: domain,
  };

  const priceNum = hero.price ?? matchedCard?.priceValue ?? parseMoney(before.price) ?? 0;
  // Truth policy (locked): current price is real; "was" is real compare-at when it
  // exists, otherwise fabricated 30% higher; reviews are real when known, otherwise
  // the fixed cosmetic 4.8 (1,478).
  const was = hero.compareAt && hero.compareAt > priceNum ? hero.compareAt : round2(priceNum * 1.3);
  const after = {
    img: afterImgUrl ?? beforeImg,
    title: copy.improved_title,
    price: fmtMoney(priceNum),
    was: fmtMoney(was),
    rating: research.reviewSignals.rating ?? 4.8,
    reviews: research.reviewSignals.count ?? 1478,
    sale: true,
    free_shipping: true,
  };

  return {
    brand: { name: research.brandName, domain },
    search_term: copy.search_term,
    ad_before: before,
    ad_after: after,
    findings: copy.findings,
    competitors: buildCompetitors(research, priceNum),
    calc: {
      aov: round2(research.aov ?? priceNum ?? 74.97),
      products: research.productCount ?? 60,
      spend: 3000,
      cpc: 1.2,
      cvr: 1.6,
    },
  };
}

function buildCompetitors(research: Research, ownPrice: number): AuditCompetitor[] {
  const brandRoot = research.domain.split('.')[0];
  const seen = new Set<string>();
  const comps: AuditCompetitor[] = [];

  for (const c of research.allCards) {
    if (comps.length >= 4) break;
    const title = (c.title ?? '').trim();
    if (!title) continue;
    const seller = (c.seller ?? '').trim();
    const sellerKey = seller.toLowerCase();
    if (sellerKey.includes(brandRoot)) continue; // exclude the prospect's own ad
    const key = `${title.toLowerCase()}|${sellerKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    comps.push({
      img: c.imageUrl ?? null,
      title: title.slice(0, 80),
      price: priceString(c.price, c.priceValue),
      store: seller || 'competitor',
    });
  }

  // Cosmetic padding when real cards are scarce — deterministic, derived from the hero.
  const PAD = [
    { mult: 1.08, store: 'primegoods.com' },
    { mult: 1.02, store: 'shopdirect.com' },
    { mult: 1.12, store: 'dailystock.com' },
    { mult: 1.05, store: 'marketlane.com' },
  ];
  let i = 0;
  while (comps.length < 4) {
    const p = PAD[i % PAD.length];
    comps.push({
      img: null,
      title: genericQuery(research.hero.title, 6),
      price: fmtMoney(round2((ownPrice || 49.99) * p.mult)),
      store: p.store,
    });
    i++;
  }
  return comps;
}

function templateCopy(research: Research): Copy {
  const { hero, matchedCard, reviewSignals } = research;
  const brand = research.brandName;
  const types = new Set(research.signals.map((s) => s.signal_type));
  const findings: AuditFinding[] = [];

  const adPrice = matchedCard?.priceValue ?? null;
  const storePrice = hero.price ?? null;
  if (types.has('price_mismatch') && adPrice && storePrice && adPrice !== storePrice) {
    findings.push({
      icon: 'sell',
      title: 'Price mismatch',
      body: `The ad shows ${fmtMoney(adPrice)}, the store charges ${fmtMoney(storePrice)}. Google can disapprove it, and shoppers feel baited and bounce.`,
    });
  }
  if (!matchedCard?.rating || types.has('no_stars_vs_competitor')) {
    findings.push({
      icon: 'star',
      title: 'No reviews showing',
      body: 'No star rating means less trust, so fewer of the clicks you pay for convert.',
    });
  }
  if (types.has('title_quality')) {
    findings.push({
      icon: 'title',
      title: 'Weak product title',
      body: 'Brand and key attributes are not front-loaded — the #1 driver of which searches the ad even shows for.',
    });
  }
  findings.push({
    icon: 'image',
    title: 'Flat catalog photo',
    body: 'A plain white-background pack shot blends into the row. Nothing earns the click.',
  });
  findings.push({
    icon: 'local_offer',
    title: 'No sale or urgency',
    body: 'No sale badge, no free shipping, no reason to buy now instead of scrolling on.',
  });

  const title = hero.title.replace(/\s+/g, ' ').trim();
  const improved = `${brand.toUpperCase()} ${title}`.slice(0, 70);
  return {
    improved_title: improved,
    search_term: research.queryText?.toLowerCase() || genericQuery(hero.title),
    findings: findings.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// Research helpers
// ---------------------------------------------------------------------------

async function fetchShopifyStore(domain: string, preferHandle: string | null) {
  try {
    const res = await fetchWithTimeout(`https://${domain}/products.json?limit=250`, 12000);
    if (!res.ok) return null;
    const json = (await res.json()) as { products?: Array<Record<string, any>> };
    const products = Array.isArray(json?.products) ? json.products : [];
    const usable = products.filter((p) => Array.isArray(p?.variants) && p.variants.length);
    if (!usable.length) return null;

    const heroProd =
      (preferHandle && usable.find((p) => p.handle === preferHandle)) ||
      usable.find(
        (p) => (p.images?.length ?? 0) > 0 && p.variants.some((v: any) => v.available !== false),
      ) ||
      usable[0];
    const variant =
      heroProd.variants.find((v: any) => v.available !== false) ?? heroProd.variants[0];
    const price = parseMoney(variant?.price);
    const compareAt = parseMoney(variant?.compare_at_price);

    const prices = usable
      .map((p) => parseMoney(p.variants?.[0]?.price))
      .filter((n): n is number => n !== null && n > 0);
    const aov = prices.length ? round2(prices.reduce((a, b) => a + b, 0) / prices.length) : null;

    return {
      hero: {
        title: String(heroProd.title ?? domain),
        handle: (heroProd.handle as string) ?? null,
        imageUrl: (heroProd.images?.[0]?.src as string) ?? null,
        price,
        compareAt: compareAt && price && compareAt > price ? compareAt : null,
        vendor: (heroProd.vendor as string) ?? null,
      },
      productCount: products.length,
      aov,
    };
  } catch {
    return null;
  }
}

async function serperShopping(query: string): Promise<ShoppingCard[]> {
  try {
    const res = await fetchWithTimeout('https://google.serper.dev/shopping', 12000, {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'us' }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Record<string, unknown>;
    return extractSerperCards(json);
  } catch {
    return [];
  }
}

function extractSerperCards(payload: unknown): ShoppingCard[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, any>;
  const list = Array.isArray(p.shopping) ? p.shopping : Array.isArray(p.results) ? p.results : [];
  return list
    .filter((c: any) => c && (c.title || c.name))
    .map((c: any) => ({
      title: c.title ?? c.name ?? null,
      price: typeof c.price === 'string' ? c.price : null,
      priceValue: parseMoney(c.priceValue ?? c.price),
      rating: typeof c.rating === 'number' ? c.rating : null,
      ratingCount: typeof c.ratingCount === 'number' ? c.ratingCount : null,
      seller: c.seller ?? c.source ?? null,
      imageUrl: c.imageUrl ?? c.image ?? null,
      link: c.link ?? null,
    }));
}

function extractReviewSignals(raw: unknown): { rating: number | null; count: number | null } {
  if (!raw || typeof raw !== 'object') return { rating: null, count: null };
  const r = raw as Record<string, any>;
  const rating = [r.rating, r.average, r.avg_rating, r.stars].map(Number).find((n) => n > 0 && n <= 5);
  const count = [r.count, r.review_count, r.total, r.reviews].map(Number).find((n) => Number.isFinite(n) && n > 0);
  return { rating: rating ?? null, count: count ? Math.round(count) : null };
}

function pickBrandName(domain: string, vendor: string | null, seller: string | null): string {
  const root = domain.split('.')[0];
  const candidate = (vendor ?? '').trim() || (seller ?? '').trim();
  if (candidate && candidate.toLowerCase() !== domain && !candidate.includes('.')) return candidate;
  return root;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'with', 'and', 'in', 'pack', 'set']);

function genericQuery(title: string, words = 3): string {
  const parts = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/\d/.test(w));
  return parts.slice(0, words).join(' ') || title.toLowerCase().slice(0, 30);
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

async function geminiRestyle(img: Buffer, mime: string, key: string): Promise<Buffer | null> {
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const prompt =
    'Recreate this exact product as a scroll-stopping Google Shopping ad photo: the product large, centered, at a slightly dynamic angle, on a bold saturated single-color studio background that complements the product, soft studio lighting, subtle grounded shadow. Photorealistic, square. Do not alter the product itself. No text, no logos, no watermarks, no people.';
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    60000,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mime, data: img.toString('base64') } },
            ],
          },
        ],
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini image generation failed: ${res.status}`);
  const json = (await res.json()) as Record<string, any>;
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const data = p?.inlineData?.data ?? p?.inline_data?.data;
    const partMime = p?.inlineData?.mimeType ?? p?.inlineData?.mime_type ?? p?.inline_data?.mimeType ?? p?.inline_data?.mime_type;
    if (!data) continue;

    const decoded = decodeBase64Bytes(data);
    if (!decoded) {
      console.warn('Gemini returned non-base64 image data; falling back to original image');
      return null;
    }

    if (!(await isSupportedImageBuffer(decoded))) {
      console.warn(
        `Gemini returned undecodable image bytes${partMime ? ` (${String(partMime)})` : ''}; falling back to original image`,
      );
      return null;
    }

    return decoded;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...init,
      signal: ctrl.signal,
      headers: { 'user-agent': 'VulcanAuditBot/1.0 (+https://vulcan.agency)', ...init?.headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

function decodeBase64Bytes(input: unknown): Buffer | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/^data:[^;,]+;base64,/, '');
  if (!trimmed || trimmed.includes('\uFFFD')) return null;

  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;

  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const bytes = Buffer.from(padded, 'base64');
  if (!bytes.length) return null;

  const canonicalInput = normalized.replace(/=+$/g, '');
  const canonicalOutput = bytes.toString('base64').replace(/=+$/g, '');
  return canonicalInput === canonicalOutput ? bytes : null;
}

async function isSupportedImageBuffer(buf: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(buf).metadata();
    return Boolean(meta.format);
  } catch {
    return false;
  }
}

function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function priceString(price: string | null | undefined, priceValue: number | null | undefined): string {
  if (typeof price === 'string' && price.trim()) {
    const t = price.trim();
    return /^[$€£]/.test(t) ? t : `$${t.replace(/^[^0-9]*/, '')}`;
  }
  if (typeof priceValue === 'number' && priceValue > 0) return fmtMoney(priceValue);
  return '$0.00';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function firstVariantNumber(variants: unknown, field: 'price' | 'compare_at_price'): number | null {
  if (!Array.isArray(variants) || !variants.length) return null;
  return parseMoney((variants[0] as Record<string, unknown>)?.[field]);
}

function extractJson(text: string): Record<string, any> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
