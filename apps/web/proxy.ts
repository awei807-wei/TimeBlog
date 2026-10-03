import { NextResponse, type NextRequest } from 'next/server';
import { DEVELOPMENT_SERVICE_WORKER } from './lib/development-service-worker';

/** 隔离开发预览，并让旧开发 worker 通过原地址升级退出。 */
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === '/sw.js') {
    if (process.env.NODE_ENV !== 'development') return NextResponse.next();
    return new NextResponse(DEVELOPMENT_SERVICE_WORKER, {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (process.env.NODE_ENV !== 'development') {
    return new NextResponse('页面不存在', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: ['/preview/writing.html', '/sw.js'] };
