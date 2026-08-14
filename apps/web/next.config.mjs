/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Keep Next's TypeScript API checker for this workspace. The 16.3 CLI
  // checker spawns a child process, which is unavailable in the restricted
  // build runner; the API path preserves the existing build behavior.
  experimental: {
    useTypeScriptCli: false,
  },
  async rewrites() {
    const apiOrigin = process.env.API_ORIGIN || 'http://localhost:8080';
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};
export default nextConfig;
