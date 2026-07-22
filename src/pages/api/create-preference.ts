import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

type SupabaseUser = {
  id?: string;
  email?: string;
};

type EbookProduct = {
  id: string;
  legacy_product_id: string | null;
  slug: string;
  title: string;
  price: number;
  currency: string | null;
  published: boolean;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function getServerVariables() {
  return {
    mercadoPagoToken: env.MERCADOPAGO_ACCESS_TOKEN,
    supabaseUrl: env.PUBLIC_SUPABASE_URL,
    supabaseAnonKey: env.PUBLIC_SUPABASE_ANON_KEY,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
    siteUrl: env.PUBLIC_SITE_URL || "https://educarepublishing.cl",
  };
}

async function validateSupabaseUser(
  supabaseUrl: string,
  supabaseAnonKey: string,
  accessToken: string
): Promise<SupabaseUser | null> {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const user = (await response.json()) as SupabaseUser;

  return user.id ? user : null;
}

async function searchProduct(
  supabaseUrl: string,
  supabaseSecretKey: string,
  column: "legacy_product_id" | "slug",
  value: string
): Promise<EbookProduct | null> {
  const params = new URLSearchParams({
    select:
      "id,legacy_product_id,slug,title,price,currency,published",
    [column]: `eq.${value}`,
    published: "eq.true",
    limit: "1",
  });

  const response = await fetch(
    `${supabaseUrl}/rest/v1/ebooks?${params.toString()}`,
    {
      headers: {
        apikey: supabaseSecretKey,
        Authorization: `Bearer ${supabaseSecretKey}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    const details = await response.text();

    console.error("Error consultando producto en Supabase:", details);

    throw new Error("No se pudo consultar el catálogo");
  }

  const products = (await response.json()) as EbookProduct[];

  return products[0] ?? null;
}

async function getProduct(
  supabaseUrl: string,
  supabaseSecretKey: string,
  productId: string
): Promise<EbookProduct | null> {
  const byLegacyId = await searchProduct(
    supabaseUrl,
    supabaseSecretKey,
    "legacy_product_id",
    productId
  );

  if (byLegacyId) {
    return byLegacyId;
  }

  return searchProduct(
    supabaseUrl,
    supabaseSecretKey,
    "slug",
    productId
  );
}

export const GET: APIRoute = async () => {
  return json({
    ok: true,
    mensaje: "API de Mercado Pago operativa",
  });
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const {
      mercadoPagoToken,
      supabaseUrl,
      supabaseAnonKey,
      supabaseSecretKey,
      siteUrl,
    } = getServerVariables();

    if (
      !mercadoPagoToken ||
      !supabaseUrl ||
      !supabaseAnonKey ||
      !supabaseSecretKey
    ) {
      return json(
        {
          error: "Faltan variables del servidor",
        },
        500
      );
    }

    const authorization =
      request.headers.get("Authorization") || "";

    const accessToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";

    if (!accessToken) {
      return json(
        {
          error: "Debes iniciar sesión para comprar",
        },
        401
      );
    }

    const user = await validateSupabaseUser(
      supabaseUrl,
      supabaseAnonKey,
      accessToken
    );

    if (!user?.id) {
      return json(
        {
          error: "La sesión no es válida o expiró",
        },
        401
      );
    }

    let body: { productId?: unknown };

    try {
      body = (await request.json()) as {
        productId?: unknown;
      };
    } catch {
      return json(
        {
          error: "La solicitud no contiene datos válidos",
        },
        400
      );
    }

    const productId = String(body.productId || "").trim();

    if (!productId) {
      return json(
        {
          error: "No se indicó el producto",
        },
        400
      );
    }

    /*
     * Busca automáticamente el ebook creado desde el administrador.
     * Acepta legacy_product_id o slug.
     */
    const product = await getProduct(
      supabaseUrl,
      supabaseSecretKey,
      productId
    );

    if (!product) {
      return json(
        {
          error:
            "El ebook no existe o todavía no está publicado",
        },
        404
      );
    }

    const price = Number(product.price);

    if (!Number.isFinite(price) || price <= 0) {
      return json(
        {
          error: "El ebook no tiene un precio válido",
        },
        400
      );
    }

    /*
     * Conservamos legacy_product_id cuando existe para mantener
     * compatibilidad con los ebooks antiguos.
     */
    const paymentProductId =
      product.legacy_product_id || product.slug;

    const externalReference =
      `${user.id}|${paymentProductId}`;

    const mercadoPagoResponse = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mercadoPagoToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [
            {
              id: paymentProductId,
              title: product.title,
              quantity: 1,
              currency_id: product.currency || "CLP",
              unit_price: price,
            },
          ],

          payer: user.email
            ? {
                email: user.email,
              }
            : undefined,

          external_reference: externalReference,

          metadata: {
            user_id: user.id,
            product_id: paymentProductId,
            ebook_id: product.id,
            ebook_slug: product.slug,
            buyer_email: user.email || "",
          },

          notification_url: `${siteUrl}/api/webhook`,

          back_urls: {
            success: `${siteUrl}/pago-exitoso`,
            failure: `${siteUrl}/pago-fallido`,
            pending: `${siteUrl}/pago-pendiente`,
          },

          auto_return: "approved",
        }),
      }
    );

    const mercadoPagoData =
      (await mercadoPagoResponse.json()) as {
        id?: string;
        init_point?: string;
        sandbox_init_point?: string;
        message?: string;
        [key: string]: unknown;
      };

    if (!mercadoPagoResponse.ok) {
      console.error(
        "Mercado Pago rechazó la preferencia:",
        mercadoPagoData
      );

      return json(
        {
          error: "Mercado Pago rechazó la solicitud",
          details: mercadoPagoData,
        },
        mercadoPagoResponse.status
      );
    }

    return json({
      id: mercadoPagoData.id,
      init_point: mercadoPagoData.init_point,
      sandbox_init_point:
        mercadoPagoData.sandbox_init_point,
    });
  } catch (error) {
    console.error("Error creando preferencia:", error);

    return json(
      {
        error: "No fue posible crear el pago",
        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
};