import type { NextConfig } from "next";

// "standalone" genera un servidor autocontenido: se despliega igual en
// AWS (ECS, App Runner, EC2), Vercel o cualquier host con Docker.
const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
