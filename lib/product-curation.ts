import Anthropic from '@anthropic-ai/sdk';

export type ProductCandidate = {
  index: number;
  handle: string;
  title: string;
  productType?: string | null;
  tags?: string[];
  vendor?: string | null;
  hasImage: boolean;
  available: boolean;
};

export type CardCandidate = {
  index: number;
  title: string;
  seller?: string | null;
  price?: string | null;
};

const IRRELEVANT_RE =
  /\b(gift\s*cards?|e-?gifts?|gift\s*certificates?|warrant(?:y|ies)|protection\s*plans?|shipping\s*protection|route\s*protection|order\s*protection|purchase\s*protection|package\s*protection|product\s*protection|extend\s*protection|insurance|donations?|tip\s*jars?|store\s*credits?|recycled\s*packaging|carbon\s*offsets?|subscriptions?|membership\s*fees?|swatches?|sample\s*packs?|fabric\s*samples?|booking\s*fees?|service\s*fees?|restocking\s*fees?|digital\s*downloads?|ebooks?|e-books?|gift\s*wrap|gift\s*boxes?|priority\s*processing|rush\s*processing|handling\s*fees?)\b/i;

const HERO_SCAN_LIMIT = 20;
const CARD_SCAN_LIMIT = 20;

export function isIrrelevantProductTitle(title: string): boolean {
  return IRRELEVANT_RE.test(title.trim());
}

/** Pick the best hero product from the first N catalog items. */
export async function selectHeroProductIndex(
  candidates: ProductCandidate[],
  options: { domain: string; preferHandle?: string | null },
): Promise<number> {
  const pool = candidates.slice(0, HERO_SCAN_LIMIT);
  if (!pool.length) return 0;

  const physical = pool.filter((c) => !isIrrelevantProductTitle(c.title));
  if (!physical.length) return pool[0].index;

  const deterministic = pickHeroDeterministic(physical, options.preferHandle);
  if (!process.env.ANTHROPIC_API_KEY || physical.length <= 1) {
    return deterministic.index;
  }

  try {
    const aiIndex = await pickHeroWithClaude(pool, options.domain);
    const chosen = pool.find((c) => c.index === aiIndex);
    if (chosen && !isIrrelevantProductTitle(chosen.title)) return chosen.index;
  } catch (err) {
    console.warn('Hero product AI curation failed; using deterministic fallback', err);
  }

  return deterministic.index;
}

/** Drop gift cards, protection plans, and other non-product shopping results. */
export async function filterRelevantCardIndices(
  heroTitle: string,
  candidates: CardCandidate[],
  domain: string,
): Promise<number[]> {
  const pool = candidates.slice(0, CARD_SCAN_LIMIT);
  if (!pool.length) return [];

  const deterministic = pool
    .filter((c) => !isIrrelevantProductTitle(c.title))
    .map((c) => c.index);

  if (!process.env.ANTHROPIC_API_KEY || pool.length <= 1) {
    return deterministic;
  }

  try {
    const aiIndices = await filterCardsWithClaude(heroTitle, pool, domain);
    const valid = new Set(pool.map((c) => c.index));
    const filtered = aiIndices.filter((i) => valid.has(i) && !isIrrelevantProductTitle(pool.find((c) => c.index === i)!.title));
    if (filtered.length) return filtered;
  } catch (err) {
    console.warn('Shopping card AI curation failed; using deterministic fallback', err);
  }

  return deterministic;
}

function pickHeroDeterministic(candidates: ProductCandidate[], preferHandle?: string | null): ProductCandidate {
  if (preferHandle) {
    const preferred = candidates.find((c) => c.handle === preferHandle);
    if (preferred) return preferred;
  }
  return (
    candidates.find((c) => c.hasImage && c.available) ??
    candidates.find((c) => c.hasImage) ??
    candidates.find((c) => c.available) ??
    candidates[0]
  );
}

async function pickHeroWithClaude(candidates: ProductCandidate[], domain: string): Promise<number> {
  const anthropic = new Anthropic();
  const msg = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    max_tokens: 300,
    system: [
      'You pick the best hero product for a Google Shopping ad audit of an e-commerce store.',
      'Choose a real physical product that represents what the store actually sells.',
      'NEVER pick: gift cards, e-gifts, warranties, protection plans (Route, Extend, shipping protection), donations, tips, store credit, subscriptions, swatches, samples, fees, or digital-only SKUs.',
      'Prefer products with images and available inventory that look like core catalog items.',
      'Return ONLY JSON: {"best_index": number} where best_index is the 0-based index into the products array.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          store_domain: domain,
          products: candidates.map((c) => ({
            index: c.index,
            title: c.title,
            handle: c.handle,
            product_type: c.productType,
            tags: c.tags?.slice(0, 8),
            has_image: c.hasImage,
            available: c.available,
          })),
        }),
      },
    ],
  });

  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const parsed = extractJson(text);
  const idx = parsed?.best_index;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
    throw new Error('Claude returned invalid best_index for hero product');
  }
  return candidates[idx].index;
}

async function filterCardsWithClaude(
  heroTitle: string,
  candidates: CardCandidate[],
  domain: string,
): Promise<number[]> {
  const anthropic = new Anthropic();
  const msg = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    max_tokens: 400,
    system: [
      'You filter Google Shopping search results for a product audit page.',
      'Keep only real physical products that are relevant competitors or comparable items to the hero product.',
      'DROP: gift cards, warranties, protection plans, shipping insurance, donations, tips, fees, unrelated services, and clearly irrelevant listings.',
      'Return ONLY JSON: {"relevant_indices": number[]} using the 0-based index field from each card.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          store_domain: domain,
          hero_product: heroTitle,
          cards: candidates.map((c) => ({
            index: c.index,
            title: c.title,
            seller: c.seller,
            price: c.price,
          })),
        }),
      },
    ],
  });

  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.relevant_indices)) {
    throw new Error('Claude returned invalid relevant_indices for shopping cards');
  }
  return parsed.relevant_indices.filter((i: unknown): i is number => typeof i === 'number' && Number.isInteger(i));
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
