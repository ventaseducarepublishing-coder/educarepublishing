import type { APIRoute } from "astro";

// El archivo JavaScript conserva toda la lógica original del webhook.
// @ts-expect-error El módulo proviene del webhook anterior.
import {
  onRequestGet,
  onRequestPost,
} from "../../server/webhook-handler.js";

export const prerender = false;

type RuntimeEnv = {
  MERCADOPAGO_ACCESS_TOKEN?: string;
  MERCADOPAGO_WEBHOOK_SECRET?: string;
  PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

function getRuntimeEnv(locals: App.Locals): RuntimeEnv {
  return (
    (
      locals as App.Locals & {
        runtime?: {
          env?: RuntimeEnv;
        };
      }
    ).runtime?.env ?? {}
  );
}

export const GET: APIRoute = async () => {
  return onRequestGet();
};

export const POST: APIRoute = async ({
  request,
  locals,
}) => {
  const env = getRuntimeEnv(locals);

  return onRequestPost({
    request,
    env,
  });
};