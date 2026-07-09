import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { generateAudit } from '@/workflows/generate-audit';
import { normalizeDomain } from '@/lib/domain';
import { svc } from '@/lib/supabase';

const FRESH_MS = 24 * 60 * 60 * 1000; // ready audits younger than this are reused
const INFLIGHT_MS = 10 * 60 * 1000; // 'generating' rows younger than this are assumed still running

/**
 * Generation trigger, called by the outbound pipeline when a prospect replies positively:
 *
 *   POST /api/audits
 *   Authorization: Bearer $AUDITS_TRIGGER_SECRET
 *   { "domain": "grip6.com", "force": false }
 *
 * Starts the research/generation workflow and returns immediately. Idempotent:
 * a fresh 'ready' audit is reused and an in-flight generation is not duplicated
 * unless force=true.
 */
export async function POST(req: Request) {
  const secret = process.env.AUDITS_TRIGGER_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { domain?: string; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const domain = normalizeDomain(body?.domain);
  if (!domain) {
    return NextResponse.json({ error: 'invalid_domain' }, { status: 400 });
  }
  const force = body?.force === true;
  const url = `/?domain=${encodeURIComponent(domain)}`;

  const sb = svc();
  const { data: existing } = await sb
    .from('shopping_audits')
    .select('status, generated_at, updated_at')
    .eq('domain_normalized', domain)
    .maybeSingle();

  if (!force && existing?.status === 'ready' && existing.generated_at) {
    const age = Date.now() - new Date(existing.generated_at).getTime();
    if (age < FRESH_MS) {
      return NextResponse.json({ status: 'ready', domain, url });
    }
  }
  if (!force && existing?.status === 'generating' && existing.updated_at) {
    const age = Date.now() - new Date(existing.updated_at).getTime();
    if (age < INFLIGHT_MS) {
      return NextResponse.json({ status: 'generating', domain, url }, { status: 202 });
    }
  }

  const { error } = await sb
    .from('shopping_audits')
    .upsert(
      { domain_normalized: domain, status: 'pending', error_message: null },
      { onConflict: 'domain_normalized' },
    );
  if (error) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  const run = await start(generateAudit, [domain]);

  return NextResponse.json(
    { status: 'started', runId: run.runId, domain, url },
    { status: 202 },
  );
}
