import { NextResponse } from 'next/server';

/** 在开始流式响应前阻止生产访问开发预览，确保真实的 HTTP 404。 */
export function proxy() {
  if (process.env.NODE_ENV !== 'development') {
    return new NextResponse('页面不存在', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: '/preview/writing.html' };
