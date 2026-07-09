import { NextResponse } from 'next/server';
import { normalizeDomain } from '@/lib/domain';
import { svc } from '@/lib/supabase';
import { DEMO_PAYLOAD } from '@/lib/demo-payload';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Public read endpoint the audit page hydrates from: GET /api/audit?domain=grip6.com
 * Returns the payload only for status='ready' rows; anything else is a 404 (plain
 * not-found on the page). Bumps view_count/first_viewed_at silently.
 */
export async function GET(req: Request) {
  const domain = normalizeDomain(new URL(req.url).searchParams.get('domain'));
  if (!domain) {
    return NextResponse.json({ error: 'invalid_domain' }, { status: 400, headers: NO_STORE });
  }

  if (process.env.AUDIT_MOCK === '1') {
    if (domain === 'grip6.com') {
      return NextResponse.json(
        { domain, payload: DEMO_PAYLOAD, generated_at: new Date().toISOString() },
        { headers: NO_STORE },
      );
    }
    if (domain === 'mockbrand.com') {
      // Values deliberately differ from the baked-in grip6 defaults so hydration
      // is visually/testably distinguishable in dev.
      const p = structuredClone(DEMO_PAYLOAD);
      p.brand = { name: 'mockbrand', domain: 'mockbrand.com' };
      p.search_term = 'ceramic pour over kettle';
      p.ad_before = { ...p.ad_before, title: 'Kettle 1.0L White', price: '$49.00', store: 'mockbrand.com' };
      p.ad_after = { ...p.ad_after, title: 'MOCKBRAND Ceramic Pour Over Kettle – 1.0L, Matte White', price: '$49.00', was: '$63.70', rating: 4.9, reviews: 2210 };
      p.findings = [
        { icon: 'title', title: 'Weak product title', body: 'Kettle 1.0L White says nothing about brand, material, or use. Google cannot match it to real searches.' },
        { icon: 'star', title: 'No reviews showing', body: 'No star rating means less trust, so fewer of the clicks you pay for convert.' },
        { icon: 'image', title: 'Flat catalog photo', body: 'A plain white-background shot blends into the row. Nothing earns the click.' },
        { icon: 'local_offer', title: 'No sale or urgency', body: 'No sale badge, no free shipping, no reason to buy now instead of scrolling on.' },
      ];
      p.competitors = [
        { img: null, title: 'Pour Over Gooseneck Kettle', price: '$54.00', store: 'brewgear.com' },
        { img: null, title: 'Ceramic Kettle Matte', price: '$59.95', store: 'kitchenline.com' },
        { img: null, title: 'Precision Pour Kettle 1L', price: '$52.00', store: 'coffeelab.com' },
        { img: null, title: 'Gooseneck Kettle White', price: '$47.50', store: 'homebarista.com' },
      ];
      p.calc = { aov: 49, products: 12, spend: 2000, cpc: 0.9, cvr: 2.1 };
      return NextResponse.json(
        { domain, payload: p, generated_at: new Date().toISOString() },
        { headers: NO_STORE },
      );
    }
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  const sb = svc();
  const { data, error } = await sb
    .from('shopping_audits')
    .select('payload, status, generated_at')
    .eq('domain_normalized', domain)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'server_error' }, { status: 500, headers: NO_STORE });
  }
  if (!data || data.status !== 'ready' || !data.payload) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  try {
    await sb.rpc('bump_audit_view', { p_domain: domain });
  } catch {
    // View tracking must never break the page.
  }

  return NextResponse.json(
    { domain, payload: data.payload, generated_at: data.generated_at },
    { headers: NO_STORE },
  );
}
