const API_URL = (process.env.API_URL ?? "http://127.0.0.1:4800").replace(
  /\/$/,
  "",
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
