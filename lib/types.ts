export type AuditFinding = {
  /** Material Symbols icon name shown in the red chip, e.g. "sell", "star", "image", "local_offer". */
  icon: string;
  title: string;
  body: string;
};

export type AuditCompetitor = {
  /** null → the page falls back to the prospect's own product image (matches the original template). */
  img: string | null;
  title: string;
  price: string;
  store: string;
};

export type AuditPayload = {
  brand: { name: string; domain: string };
  search_term: string;
  ad_before: { img: string; title: string; price: string; store: string };
  ad_after: {
    img: string;
    title: string;
    price: string;
    was: string;
    rating: number | null;
    reviews: number | null;
    sale: boolean;
    free_shipping: boolean;
  };
  findings: AuditFinding[];
  competitors: AuditCompetitor[];
  calc: { aov: number; products: number; spend: number; cpc: number; cvr: number };
};
