/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  async rewrites() {
    const apiOrigin = process.env.API_ORIGIN || 'http://localhost:8080';
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};
export default nextConfig;
