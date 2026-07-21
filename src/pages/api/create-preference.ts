import type { APIRoute } from "astro";
import { createClient } from "@supabase/supabase-js";

export const prerender = false;

type EbookRow = {
  id: string;
  legacy_product_id: string | null;
  slug: string;
  title: string;
  description: string | null;
  price: number | string;
  currency: string | null;
  cover_url: string | null;
  published: boolean;
};

type RequestBody = {
  productId?: unknown;
};

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
const mercadoPagoAccessToken = import.meta.env.MERCADOPAGO_ACCESS_TOKEN;
const configuredSiteUrl = import.meta.env.PUBLIC_SITE_URL;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function normalizeSiteUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

async function findPublishedEbook(
  supabase: ReturnType<typeof createClient>,
  productId: string
): Promise<{ ebook: EbookRow | null; error: string | null }> {
  const fields = `
    id,
    legacy_product_id,
    slug,
    title,
    description,
    price,
    currency,
    cover_url,
    published
  `;

  const attempts: Array<{
    column: "legacy_product_id" | "slug" | "id";
    enabled: boolean;
  }> = [
    { column: "legacy_product_id", enabled: true },
    { column: "slug", enabled: true },
    { column: "id", enabled: isUuid(productId) },
  ];

  for (const attempt of attempts) {
    if (!attempt.enabled) continue;

    const { data, error } = await supabase
      .from("ebooks")
      .select(fields)
      .eq(attempt.column, productId)
      .eq("published", true)
      .maybeSingle();

    if (error) {
      console.error(`Error buscando ebook por ${attempt.column}:`, error);
      return { ebook: null, error: error.message };
    }

    if (data) {
      return { ebook: data as EbookRow, error: null };
    }
  }

  return { ebook: null, error: null };
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
    if (!supabaseUrl || !supabaseAnonKey) {
      return jsonResponse(
        {
          error:
            "Falta configurar PUBLIC_SUPABASE_URL o PUBLIC_SUPABASE_ANON_KEY.",
        },
        500
      );
    }

    if (!mercadoPagoAccessToken) {
      return jsonResponse(
        {
          error:
            "Falta configurar MERCADOPAGO_ACCESS_TOKEN en las variables de entorno.",
        },
        500
      );
    }

    const authorization = request.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse(
        { error: "Debes iniciar sesión antes de comprar." },
        401
      );
    }

    const userAccessToken = authorization.slice(7).trim();

    if (!userAccessToken) {
      return jsonResponse(
        { error: "La sesión enviada no es válida." },
        401
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${userAccessToken}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(userAccessToken);

    if (userError || !user) {
      console.error("Error validando sesión:", userError);

      return jsonResponse(
        { error: "La sesión expiró. Vuelve a iniciar sesión." },
        401
      );
    }

    let body: RequestBody;

    try {
      body = (await request.json()) as RequestBody;
    } catch {
      return jsonResponse(
        { error: "La solicitud no contiene JSON válido." },
        400
      );
    }

    const productId =
      typeof body.productId === "string" ? body.productId.trim() : "";

    if (!productId) {
      return jsonResponse(
        { error: "No se recibió el identificador del ebook." },
        400
      );
    }

    console.log("Producto recibido:", productId);

    const { ebook, error: ebookSearchError } =
      await findPublishedEbook(supabase, productId);

    if (ebookSearchError) {
      return jsonResponse(
        {
          error: "No se pudo consultar el ebook.",
          details: ebookSearchError,
        },
        500
      );
    }

    if (!ebook) {
      return jsonResponse(
        { error: "El ebook solicitado no existe o no está publicado." },
        404
      );
    }

    const unitPrice = Number(ebook.price);

    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      return jsonResponse(
        { error: "El ebook no tiene un precio válido." },
        400
      );
    }

    const currency = (ebook.currency || "CLP").toUpperCase();
    const siteUrl = normalizeSiteUrl(configuredSiteUrl || url.origin);

    const preference = {
      items: [
        {
          id: ebook.legacy_product_id || ebook.slug || ebook.id,
          title: ebook.title,
          description:
            ebook.description || "Ebook digital de Educare Publishing",
          picture_url: ebook.cover_url || undefined,
          quantity: 1,
          currency_id: currency,
          unit_price: unitPrice,
        },
      ],
      payer: {
        email: user.email,
      },
      external_reference: JSON.stringify({
        user_id: user.id,
        ebook_id: ebook.id,
      }),
      back_urls: {
        success: `${siteUrl}/mi-biblioteca?payment=success`,
        pending: `${siteUrl}/mi-biblioteca?payment=pending`,
        failure: `${siteUrl}/?payment=failure`,
      },
      notification_url: `${siteUrl}/api/webhook`,
      auto_return: "approved",
      metadata: {
        user_id: user.id,
        ebook_id: ebook.id,
        product_id: ebook.legacy_product_id || ebook.slug || ebook.id,
      },
    };

    const mercadoPagoResponse = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mercadoPagoAccessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(preference),
      }
    );

    const mercadoPagoData = await readJsonSafely(mercadoPagoResponse);

    if (!mercadoPagoResponse.ok) {
      console.error("========== MERCADO PAGO ==========");
      console.error("Status:", mercadoPagoResponse.status);
      console.error("Respuesta:", mercadoPagoData);
      console.error("==================================");

      return jsonResponse(
        {
          error: "Mercado Pago rechazó la creación del pago.",
          details: mercadoPagoData,
        },
        mercadoPagoResponse.status
      );
    }

    console.log("Respuesta completa de Mercado Pago:");
    console.log(JSON.stringify(mercadoPagoData, null, 2));

    const paymentData =
      mercadoPagoData && typeof mercadoPagoData === "object"
        ? (mercadoPagoData as Record<string, unknown>)
        : {};

    const initPoint =
      typeof paymentData.init_point === "string"
        ? paymentData.init_point
        : null;

    const sandboxInitPoint =
      typeof paymentData.sandbox_init_point === "string"
        ? paymentData.sandbox_init_point
        : null;

    if (!initPoint && !sandboxInitPoint) {
      console.error(
        "Mercado Pago no devolvió una URL de pago:",
        mercadoPagoData
      );

      return jsonResponse(
        {
          error: "Mercado Pago no devolvió el enlace de pago.",
          details: mercadoPagoData,
        },
        502
      );
    }

    return jsonResponse({
      id: typeof paymentData.id === "string" ? paymentData.id : null,
      init_point: initPoint,
      sandbox_init_point: sandboxInitPoint,
    });
  } catch (error) {
    console.error("Error inesperado al crear la preferencia:", error);

    return jsonResponse(
      {
        error: "Ocurrió un error inesperado al preparar el pago.",
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
};

export const ALL: APIRoute = async () => {
  return jsonResponse(
    {
      error: "Método no permitido. Esta ruta acepta solamente POST.",
    },
    405
  );
};