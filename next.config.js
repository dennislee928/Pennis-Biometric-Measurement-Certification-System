const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH || '',
  transpilePackages: ['@tensorflow/tfjs'],
  images: { unoptimized: true },
  webpack: (config, { isServer }) => {
    if (isServer) return config;
    config.resolve.fallback = {
      fs: false, path: false, crypto: false, tls: false,
      net: false, stream: false, http: false, https: false,
      zlib: false,
    };
    config.resolve.alias = {
      ...config.resolve.alias,
      'tslib': path.resolve(__dirname, 'node_modules/tslib/tslib.js'),
    };
    return config;
  },
};

module.exports = nextConfig;