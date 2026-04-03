/** @type {import('next').NextConfig} */
const nextConfig = {
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
