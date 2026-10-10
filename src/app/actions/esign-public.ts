"use server";

import { headers } from "next/headers";
import { declineRequest, sendCode, submitSignature } from "@/lib/esign";
import { clientInfo } from "@/lib/esign-request";
import { toUserMessage } from "@/lib/errors";

// Acciones de la página pública de firma (/firma/<token>): sin sesión, el enlace es la llave.

export async function requestSignCodeAction(token: string): Promise<{ error?: string }> {
  try { await sendCode(token, clientInfo(await headers()).ip); return {}; } catch (err) { return { error: toUserMessage(err) }; }
}

export async function submitSignatureAction(token: string, v: { values: Record<string, string>; code?: string | null; consent: boolean }): Promise<{ error?: string }> {
  const { ip, ua } = clientInfo(await headers());
  try { await submitSignature(token, v, ip, ua); return {}; } catch (err) { return { error: toUserMessage(err) }; }
}

export async function declineSignAction(token: string, reason: string): Promise<{ error?: string }> {
  const { ip, ua } = clientInfo(await headers());
  try { await declineRequest(token, reason, ip, ua); return {}; } catch (err) { return { error: toUserMessage(err) }; }
}
