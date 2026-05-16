const path = require('path');
const webpack = require('webpack');

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
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /^iceberg-js$/,
        path.resolve(__dirname, 'lib/stubs/iceberg-js.js')
      ),
      new webpack.NormalModuleReplacementPlugin(
        /@supabase\/storage-js/,
        path.resolve(__dirname, 'lib/stubs/storage-js.js')
      ),
      new webpack.NormalModuleReplacementPlugin(
        /^tslib$/,
        path.resolve(__dirname, 'node_modules/tslib/tslib.js')
      ),
    );
    return config;
  },
};

module.exports = nextConfig;
