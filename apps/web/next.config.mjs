/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@aide/auth', '@aide/config', '@aide/db', '@aide/api-types'],
  async rewrites() {
    const apiInternal = process.env.API_INTERNAL_URL ?? 'http://localhost:3001'
    return [
      { source: '/trpc/:path*', destination: `${apiInternal}/trpc/:path*` },
      { source: '/api/v1/:path*', destination: `${apiInternal}/api/v1/:path*` }
    ]
  },
  webpack: (config) => {
    // Workspace packages expose TS source with NodeNext-style `.js` specifiers.
    // Tell webpack to resolve `.js` imports to `.ts`/`.tsx` when the file exists.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs']
    }
    return config
  }
}

export default nextConfig
