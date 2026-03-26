/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  outputFileTracingExcludes: {
    "api/**/*": [
      "anchor/programs/**/*",
      "anchor/target/**/*",
      "pocketchange-vault/**/*"
    ]
  }
};

export default nextConfig;
