import type { AuditPayload } from './types';

/**
 * The grip6 demo payload — identical to the row seeded in shopping_audits and to the
 * original hand-built static page. Served by GET /api/audit when AUDIT_MOCK=1 so the
 * page can be developed and tested without Supabase credentials.
 */
export const DEMO_PAYLOAD: AuditPayload = {
  brand: { name: 'grip6', domain: 'grip6.com' },
  search_term: 'merino wool socks',
  ad_before: {
    img: 'https://cdn.shopify.com/s/files/1/1310/9209/files/3PackIndigo.avif?v=1762461743',
    title: '3 Pack Indigo – Casual Crew Midweight Merino Wool Sock',
    price: '$66.95',
    store: 'grip6.com',
  },
  ad_after: {
    img: 'standout-sock.png',
    title: "GRIP6 Men's Merino Wool Crew Socks – Indigo, Midweight, 3-Pack",
    price: '$63.72',
    was: '$74.97',
    rating: 4.8,
    reviews: 1284,
    sale: true,
    free_shipping: true,
  },
  findings: [
    {
      icon: 'sell',
      title: 'Price mismatch',
      body: 'The ad shows $66.95, the store charges $74.97. Google can disapprove it, and shoppers feel baited and bounce.',
    },
    {
      icon: 'star',
      title: 'No reviews showing',
      body: 'No star rating means less trust, so fewer of the clicks you pay for convert.',
    },
    {
      icon: 'image',
      title: 'Flat catalog photo',
      body: 'A plain white-background pack shot blends into the row. Nothing earns the click.',
    },
    {
      icon: 'local_offer',
      title: 'No sale or urgency',
      body: 'No sale badge, no free shipping, no reason to buy now instead of scrolling on.',
    },
  ],
  competitors: [
    { img: null, title: 'Merino Wool Crew Socks 3-Pack', price: '$72.00', store: 'sockco.com' },
    { img: null, title: "Men's Wool Crew Socks", price: '$69.95', store: 'woolworks.com' },
    { img: null, title: 'Premium Merino Crew Socks', price: '$74.00', store: 'footgear.com' },
    { img: null, title: 'Wool Blend Socks 3 Pack', price: '$68.00', store: 'sockhub.com' },
  ],
  calc: { aov: 74.97, products: 60, spend: 3000, cpc: 1.2, cvr: 1.6 },
};
