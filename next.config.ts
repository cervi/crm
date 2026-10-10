import type { NextConfig } from "next";

// "standalone" genera un servidor autocontenido: se despliega igual en
// AWS (ECS, App Runner, EC2), Vercel o cualquier host con Docker.
const nextConfig: NextConfig = {
  output: "standalone",
  // El «worker» de pdf.js se lee del disco en tiempo de ejecución: que vaya también en la build.
  outputFileTracingIncludes: { "/api/public/pdf-worker": ["./node_modules/pdfjs-dist/build/pdf.worker.min.mjs"] },
};

export default nextConfig;
