const productos = {
  recien_nacido: {
    title: "Guía Completa del Primer Año del Bebé",
    price: 39990,
  },

  sopas_caseras: {
    title: "Las Mejores Sopas del Mundo",
    price: 29990,
  },

  lactancia_materna: {
    title: "Lactancia Materna",
    price: 50000,
  },
};

export function onRequestGet() {
  return Response.json({
    ok: true,
    mensaje: "API de Mercado Pago operativa",
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (
      !env.MERCADOPAGO_ACCESS_TOKEN ||
      !env.PUBLIC_SUPABASE_URL ||
      !env.PUBLIC_SUPABASE_ANON_KEY
    ) {
      return Response.json(
        {
          error: "Faltan variables del servidor",
        },
        {
          status: 500,
        }
      );
    }

    /*
     * El index.astro envía el token de sesión mediante:
     * Authorization: Bearer TOKEN
     */
    const authorization =
      request.headers.get("Authorization") || "";

    const accessToken =
      authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

    if (!accessToken) {
      return Response.json(
        {
          error: "Debes iniciar sesión para comprar",
        },
        {
          status: 401,
        }
      );
    }

    /*
     * Validamos el token directamente contra Supabase.
     * No confiamos solamente en los datos enviados por el navegador.
     */
    const userResponse = await fetch(
      `${env.PUBLIC_SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey: env.PUBLIC_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const user = await userResponse.json();

    if (!userResponse.ok || !user.id) {
      return Response.json(
        {
          error: "La sesión no es válida o expiró",
        },
        {
          status: 401,
        }
      );
    }

    const body = await request.json();
    const productId = String(body.productId || "");
    const producto = productos[productId];

    if (!producto) {
      return Response.json(
        {
          error: "Producto no válido",
        },
        {
          status: 400,
        }
      );
    }

    const externalReference =
      `${user.id}|${productId}`;

    const mpResponse = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,

          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          items: [
            {
              id: productId,
              title: producto.title,
              quantity: 1,
              currency_id: "CLP",
              unit_price: producto.price,
            },
          ],



          external_reference: externalReference,

          metadata: {
            user_id: user.id,
            product_id: productId,
            buyer_email: user.email,
          },

          notification_url:
            "https://educarepublishing.cl/api/webhook",

          back_urls: {
            success:
              "https://educarepublishing.cl/pago-exitoso",

            failure:
              "https://educarepublishing.cl/pago-fallido",

            pending:
              "https://educarepublishing.cl/pago-pendiente",
          },

          auto_return: "approved",
        }),
      }
    );

    const data = await mpResponse.json();

    if (!mpResponse.ok) {
      console.error(
        "Mercado Pago rechazó la preferencia:",
        data
      );

      return Response.json(
        {
          error: "Mercado Pago rechazó la solicitud",
          details: data,
        },
        {
          status: mpResponse.status,
        }
      );
    }

    return Response.json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
    });
  } catch (error) {
    console.error(
      "Error creando preferencia:",
      error
    );

    return Response.json(
      {
        error: "No fue posible crear el pago",

        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      {
        status: 500,
      }
    );
  }
}