import { NextResponse } from 'next/server';
import { adminUnauthorized, isAdminAuthorized } from '@/lib/admin-auth';
import { enrichBrandLogo } from '@/lib/brand-logo';
import { normalizeDomain } from '@/lib/domain';
import { svc } from '@/lib/supabase';
import type { AuditPayload } from '@/lib/types';

const NO_STORE = { 'cache-control': 'no-store' };

/** Admin read: full audit row for editing. GET /api/admin/audit?domain=grip6.com */
export async function GET(req: Request) {
  if (!isAdminAuthorized(req)) return adminUnauthorized();

  const domain = normalizeDomain(new URL(req.url).searchParams.get('domain'));
  if (!domain) {
    return NextResponse.json({ error: 'invalid_domain' }, { status: 400, headers: NO_STORE });
  }

  const { data, error } = await svc()
    .from('shopping_audits')
    .select('domain_normalized, status, payload, generated_at, error_message, updated_at')
    .eq('domain_normalized', domain)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'server_error' }, { status: 500, headers: NO_STORE });
  }
  if (!data) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  let payload = data.payload as AuditPayload | null;
  if (payload?.brand) {
    payload = { ...payload, brand: await enrichBrandLogo(payload.brand) };
  }

  return NextResponse.json(
    {
      domain: data.domain_normalized,
      status: data.status,
      payload,
      generated_at: data.generated_at,
      error_message: data.error_message,
      updated_at: data.updated_at,
    },
    { headers: NO_STORE },
  );
}

/** Admin write: replace payload. PATCH /api/admin/audit { domain, payload } */
export async function PATCH(req: Request) {
  if (!isAdminAuthorized(req)) return adminUnauthorized();

  let body: { domain?: string; payload?: AuditPayload };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers: NO_STORE });
  }

  const domain = normalizeDomain(body?.domain);
  if (!domain) {
    return NextResponse.json({ error: 'invalid_domain' }, { status: 400, headers: NO_STORE });
  }
  if (!body.payload || typeof body.payload !== 'object') {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400, headers: NO_STORE });
  }

  const payload = body.payload;
  payload.brand = {
    name: String(payload.brand?.name ?? domain.split('.')[0]),
    domain,
    logo_url: payload.brand?.logo_url ?? null,
    logo_alt: payload.brand?.logo_alt ?? null,
  };

  const { data, error } = await svc()
    .from('shopping_audits')
    .upsert(
      {
        domain_normalized: domain,
        status: 'ready',
        payload,
        payload_version: 1,
        error_message: null,
        generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'domain_normalized' },
    )
    .select('domain_normalized, status, generated_at, updated_at')
    .single();

  if (error) {
    return NextResponse.json({ error: 'server_error', detail: error.message }, { status: 500, headers: NO_STORE });
  }

  return NextResponse.json(
    { ok: true, domain: data.domain_normalized, status: data.status, generated_at: data.generated_at, updated_at: data.updated_at },
    { headers: NO_STORE },
  );
}
