import { NextResponse } from "next/server";
import { agentFromHeaders } from "@/lib/agents";
import { handleRpc } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/**
 * Servidor MCP (transporte «Streamable HTTP», respuestas JSON) para agentes
 * externos. Autenticación: `Authorization: Bearer <clave del agente>`.
 */
export async function POST(req: Request) {
  const agent = await agentFromHeaders(req.headers);
  if (!agent) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Clave de agente no válida o revocada." } }, {
      status: 401, headers: { "WWW-Authenticate": 'Bearer realm="crm-mcp"' },
    });
  }
  const body = await req.json().catch(() => undefined);
  if (body === undefined) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON no válido" } }, { status: 400 });
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(agent, m)))).filter(Boolean);
    return out.length ? NextResponse.json(out) : new Response(null, { status: 202 });
  }
  const res = await handleRpc(agent, body);
  return res ? NextResponse.json(res) : new Response(null, { status: 202 });
}

/** Sin flujo de eventos del servidor (SSE): todo va por POST. */
export function GET() {
  return new Response("Usa POST (JSON-RPC).", { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
