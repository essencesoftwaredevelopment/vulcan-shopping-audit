import { NextResponse } from 'next/server';

export function isAdminAuthorized(req: Request): boolean {
  const secret = process.env.AUDITS_TRIGGER_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  return Boolean(secret && auth === `Bearer ${secret}`);
}

export function adminUnauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}
