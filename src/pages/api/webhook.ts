import type { APIRoute } from "astro";
import { createClient } from "@supabase/supabase-js";

export const prerender = false;

type MercadoPagoNotification = {
  type?: string;
  action?: string;
  data?: { id?: string | number };
};

type MercadoPagoPayment = {
  id?: number | string;
  status?: string;
  status_detail?: string;
  transaction_amount?: number;
  currency_id?: string;
  preference_id?: string;
  external_reference?: string;
  metadata?: {
    user_id?: string;
    ebook_id?: string;
    product_id?: string;
  };
  payer?: { email?: string };
};

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseSecretKey =
  import.meta.env.SUPABASE_SECRET_KEY ||
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
const mercadoPagoAccessToken =
  import.meta.env.MERCADOPAGO_ACCESS_TOKEN;
const mercadoPagoWebhookSecret =
  import.meta.env.MERCADOPAGO_WEBHOOK_SECRET;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function parseSignatureHeader(header: string) {
  let ts: string | null = null;
  let v1: string | null = null;

  for (const part of header.split(",")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = rawKey?.trim();
    const value = rawValue?.trim();

    if (key === "ts") ts = value || null;
    if (key === "v1") v1 = value || null;
  }

  return { ts, v1 };
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return result === 0;
}

async function validateWebhookSignature({
  dataId,
  xRequestId,
  xSignature,
  secret,
}: {
  dataId: string;
  xRequestId: string;
  xSignature: string;
  secret: string;
}): Promise<boolean> {
  const { ts, v1 } = parseSignatureHeader(xSignature);

  if (!ts || !v1) return false;

  const normalizedDataId = /[a-z]/i.test(dataId)
    ? dataId.toLowerCase()
    : dataId;

  const parts: string[] = [];

  if (normalizedDataId) parts.push(`id:${normalizedDataId};`);
  if (xRequestId) parts.push(`request-id:${xRequestId};`);
  parts.push(`ts:${ts};`);

  const manifest = parts.join("");
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(manifest)
  );

  return constantTimeEqual(bytesToHex(signature), v1);
}

function extractPurchaseMetadata(payment: MercadoPagoPayment) {
  if (payment.metadata?.user_id && payment.metadata?.ebook_id) {
    return {
      userId: payment.metadata.user_id,
      ebookId: payment.metadata.ebook_id,
    };
  }

  if (!payment.external_reference) {
    return { userId: null, ebookId: null };
  }

  try {
    const parsed = JSON.parse(payment.external_reference) as {
      user_id?: string;
      ebook_id?: string;
    };

    return {
      userId: parsed.user_id || null,
      ebookId: parsed.ebook_id || null,
    };
  } catch {
    return { userId: null, ebookId: null };
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw_response: text.slice(0, 1000) };
  }
}

export const POST: APIRoute = async ({ request, url }) => {
  try {
    if (!supabaseUrl || !supabaseSecretKey || !mercadoPagoAccessToken) {
      return jsonResponse(
        { error: "Faltan variables privadas del servidor." },
        500
      );
    }

    let body: MercadoPagoNotification;

    try {
      body = (await request.json()) as MercadoPagoNotification;
    } catch {
      return jsonResponse(
        { error: "La notificación no contiene JSON válido." },
        400
      );
    }

    const queryDataId =
      url.searchParams.get("data.id") ||
      url.searchParams.get("id");

    const paymentId = String(
      queryDataId || body.data?.id || ""
    ).trim();

    const notificationType =
      url.searchParams.get("type") ||
      body.type ||
      "";

    if (notificationType && notificationType !== "payment") {
      return jsonResponse({
        received: true,
        ignored: true,
      });
    }

    if (!paymentId) {
      return jsonResponse(
        { error: "No se recibió el ID del pago." },
        400
      );
    }

    if (mercadoPagoWebhookSecret) {
      const xSignature =
        request.headers.get("x-signature") || "";
      const xRequestId =
        request.headers.get("x-request-id") || "";

      const valid =
        xSignature &&
        xRequestId &&
        (await validateWebhookSignature({
          dataId: queryDataId || paymentId,
          xRequestId,
          xSignature,
          secret: mercadoPagoWebhookSecret,
        }));

      if (!valid) {
        return jsonResponse(
          { error: "Firma de webhook inválida." },
          401
        );
      }
    }

    const paymentResponse = await fetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
        paymentId
      )}`,
      {
        headers: {
          Authorization: `Bearer ${mercadoPagoAccessToken}`,
          Accept: "application/json",
        },
      }
    );

    const paymentData = await readJsonSafely(paymentResponse);

    if (!paymentResponse.ok) {
      console.error("No se pudo verificar el pago:", paymentData);

      return jsonResponse(
        { error: "No se pudo verificar el pago." },
        502
      );
    }

    const payment = paymentData as MercadoPagoPayment;
    const { userId, ebookId } =
      extractPurchaseMetadata(payment);

    if (!userId || !ebookId) {
      return jsonResponse(
        {
          error:
            "El pago no contiene user_id y ebook_id.",
        },
        422
      );
    }

    const supabaseAdmin = createClient(
      supabaseUrl,
      supabaseSecretKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      }
    );

    const { data: ebook, error: ebookError } =
      await supabaseAdmin
        .from("ebooks")
        .select("id, price, currency")
        .eq("id", ebookId)
        .maybeSingle();

    if (ebookError || !ebook) {
      return jsonResponse(
        { error: "No se pudo verificar el ebook." },
        500
      );
    }

    const paidAmount = Number(payment.transaction_amount || 0);
    const expectedAmount = Number(ebook.price || 0);
    const paidCurrency = (
      payment.currency_id || ""
    ).toUpperCase();
    const expectedCurrency = (
      ebook.currency || "CLP"
    ).toUpperCase();

    if (
      paidAmount !== expectedAmount ||
      paidCurrency !== expectedCurrency
    ) {
      return jsonResponse(
        {
          error:
            "El monto o la moneda no coincide con el ebook.",
        },
        422
      );
    }

    const purchaseRecord = {
      user_id: userId,
      ebook_id: ebookId,
      payment_id: String(payment.id || paymentId),
      preference_id: payment.preference_id || null,
      status: payment.status || "unknown",
      status_detail: payment.status_detail || null,
      amount: paidAmount,
      currency: paidCurrency,
      payer_email: payment.payer?.email || null,
      updated_at: new Date().toISOString(),
      raw_payment: payment,
    };

    const { error: purchaseError } =
      await supabaseAdmin
        .from("purchases")
        .upsert(purchaseRecord, {
          onConflict: "payment_id",
        });

    if (purchaseError) {
      console.error("No se pudo guardar la compra:", purchaseError);

      return jsonResponse(
        { error: "No se pudo registrar la compra." },
        500
      );
    }

    return jsonResponse({
      received: true,
      payment_id: purchaseRecord.payment_id,
      status: purchaseRecord.status,
    });
  } catch (error) {
    console.error("Error inesperado en webhook:", error);

    return jsonResponse(
      {
        error:
          "Ocurrió un error inesperado procesando el webhook.",
      },
      500
    );
  }
};

export const ALL: APIRoute = async () => {
  return jsonResponse(
    {
      error:
        "Método no permitido. Esta ruta acepta solamente POST.",
    },
    405
  );
};