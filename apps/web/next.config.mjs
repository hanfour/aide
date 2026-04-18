/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@aide/auth', '@aide/config', '@aide/db'],
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
