import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { generateAudit } from '@/workflows/generate-audit';
import { normalizeDomain } from '@/lib/domain';
import { svc } from '@/lib/supabase';

const INFLIGHT_MS = 10 * 60 * 1000; // 'generating' rows younger than this are assumed still running

/**
 * Generation trigger, called by the outbound pipeline when a prospect replies positively:
 *
 *   POST /api/audits
 *   Authorization: Bearer $AUDITS_TRIGGER_SECRET
 *   { "domain": "grip6.com" }
 *
 * Starts a fresh research/generation workflow and returns immediately. A completed
 * audit is regenerated on every request; an in-flight generation is not duplicated.
 */
export async function POST(req: Request) {
  const secret = process.env.AUDITS_TRIGGER_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { domain?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const domain = normalizeDomain(body?.domain);
  if (!domain) {
    return NextResponse.json({ error: 'invalid_domain' }, { status: 400 });
  }
  const url = `/?domain=${encodeURIComponent(domain)}`;

  const sb = svc();
  const { data: existing } = await sb
    .from('shopping_audits')
    .select('status, updated_at')
    .eq('domain_normalized', domain)
    .maybeSingle();

  if (existing?.status === 'generating' && existing.updated_at) {
    const age = Date.now() - new Date(existing.updated_at).getTime();
    if (age < INFLIGHT_MS) {
      return NextResponse.json({ status: 'generating', domain, url }, { status: 202 });
    }
  }

  const { error } = await sb
    .from('shopping_audits')
    .upsert(
      // Set this before enqueueing so an immediate repeat request sees the run.
      { domain_normalized: domain, status: 'generating', error_message: null, updated_at: new Date().toISOString() },
      { onConflict: 'domain_normalized' },
    );
  if (error) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  try {
    const run = await start(generateAudit, [domain]);
    return NextResponse.json(
      { status: 'started', runId: run.runId, domain, url },
      { status: 202 },
    );
  } catch (err) {
    await sb
      .from('shopping_audits')
      .upsert(
        {
          domain_normalized: domain,
          status: 'failed',
          error_message: err instanceof Error ? err.message.slice(0, 500) : 'Failed to start audit workflow',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'domain_normalized' },
      );
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
