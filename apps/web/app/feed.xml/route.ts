import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const origin = process.env.API_ORIGIN || 'http://localhost:8080';
  const upstream = await fetch(`${origin}/api/v1/public/feed`, { headers: { Accept: 'application/atom+xml' }, cache: 'no-store' }).catch(() => null);
  if (!upstream) return new NextResponse('Feed unavailable', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const body = await upstream.text();
  return new NextResponse(body, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/atom+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
