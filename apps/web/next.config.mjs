/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@aide/auth', '@aide/config', '@aide/db']
}

export default nextConfig
