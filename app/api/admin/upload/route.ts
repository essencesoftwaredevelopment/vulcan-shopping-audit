import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { adminUnauthorized, isAdminAuthorized } from '@/lib/admin-auth';
import { normalizeDomain } from '@/lib/domain';
import { svc } from '@/lib/supabase';

const NO_STORE = { 'cache-control': 'no-store' };
const MAX_BYTES = 8 * 1024 * 1024;

/** Upload an audit image to Storage. POST multipart: domain, slot, file */
export async function POST(req: Request) {
  if (!isAdminAuthorized(req)) return adminUnauthorized();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_form' }, { status: 400, headers: NO_STORE });
  }

  const domain = normalizeDomain(form.get('domain')?.toString());
  const slot = (form.get('slot')?.toString() ?? 'image').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
  const file = form.get('file');

  if (!domain) {
    return NextResponse.json({ error: 'invalid_domain' }, { status: 400, headers: NO_STORE });
  }
  if (!(file instanceof File) || !file.size) {
    return NextResponse.json({ error: 'missing_file' }, { status: 400, headers: NO_STORE });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'file_too_large' }, { status: 400, headers: NO_STORE });
  }

  const input = Buffer.from(await file.arrayBuffer());
  let webp: Buffer;
  try {
    webp = await sharp(input)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    return NextResponse.json({ error: 'invalid_image' }, { status: 400, headers: NO_STORE });
  }

  const path = `${domain}/admin-${slot}-${Date.now()}.webp`;
  const sb = svc();
  const body = new Blob([new Uint8Array(webp)], { type: 'image/webp' });
  const { error } = await sb.storage
    .from('audit-assets')
    .upload(path, body, { contentType: 'image/webp', upsert: true });

  if (error) {
    return NextResponse.json({ error: 'upload_failed', detail: error.message }, { status: 500, headers: NO_STORE });
  }

  const url = sb.storage.from('audit-assets').getPublicUrl(path).data.publicUrl;
  return NextResponse.json({ ok: true, url, path }, { headers: NO_STORE });
}
