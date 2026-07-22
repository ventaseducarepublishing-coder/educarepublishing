const files = {
  recien_nacido:
    "recien_nacido/guia-primer-ano-bebe.pdf",

  lactancia_materna:
    "lactancia_materna/lactancia-materna.pdf",

  sopas_caseras:
    "sopas_caseras/mejores-sopas-del-mundo.pdf",
};

export async function onRequestPost({ request, env }) {
  try {
    if (
      !env.PUBLIC_SUPABASE_URL ||
      !env.PUBLIC_SUPABASE_ANON_KEY ||
      !env.SUPABASE_SERVICE_ROLE_KEY
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

    const authorization =
      request.headers.get("Authorization") || "";

    const accessToken =
      authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

    if (!accessToken) {
      return Response.json(
        {
          error: "Debes iniciar sesión",
        },
        {
          status: 401,
        }
      );
    }

    let body = {};

    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          error: "Solicitud inválida",
        },
        {
          status: 400,
        }
      );
    }

    const productId = String(
      body.productId || ""
    );

    const filePath = files[productId];

    if (!productId || !filePath) {
      return Response.json(
        {
          error: "Producto no válido",
        },
        {
          status: 404,
        }
      );
    }

    /*
     * Validamos la sesión directamente con Supabase.
     */
    const userResponse = await fetch(
      `${env.PUBLIC_SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey:
            env.PUBLIC_SUPABASE_ANON_KEY,

          Authorization:
            `Bearer ${accessToken}`,
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

    /*
     * Comprobamos que el usuario tenga una compra
     * aprobada del ebook solicitado.
     */
    const purchasesUrl =
      `${env.PUBLIC_SUPABASE_URL}/rest/v1/purchases` +
      `?user_id=eq.${encodeURIComponent(user.id)}` +
      `&product_id=eq.${encodeURIComponent(productId)}` +
      `&status=eq.approved` +
      `&select=id` +
      `&limit=1`;

    const purchaseResponse = await fetch(
      purchasesUrl,
      {
        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    const purchases =
      await purchaseResponse.json();

    if (!purchaseResponse.ok) {
      console.error(
        "Error consultando compra:",
        purchases
      );

      return Response.json(
        {
          error:
            "No fue posible validar la compra",
        },
        {
          status: 500,
        }
      );
    }

    if (
      !Array.isArray(purchases) ||
      purchases.length === 0
    ) {
      return Response.json(
        {
          error:
            "No encontramos una compra aprobada para este ebook",
        },
        {
          status: 403,
        }
      );
    }

    /*
     * Generamos un enlace temporal de 5 minutos.
     */
    const signedResponse = await fetch(
      `${env.PUBLIC_SUPABASE_URL}/storage/v1/object/sign/ebooks/${filePath}`,
      {
        method: "POST",

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          expiresIn: 300,
        }),
      }
    );

    const signed =
      await signedResponse.json();

    if (!signedResponse.ok) {
      console.error(
        "Error creando enlace firmado:",
        signed
      );

      return Response.json(
        {
          error:
            signed.message ||
            "No fue posible preparar la descarga",
          details: signed,
        },
        {
          status: 500,
        }
      );
    }

    const signedUrl =
      signed.signedURL ||
      signed.signedUrl;

    if (!signedUrl) {
      return Response.json(
        {
          error:
            "Supabase no devolvió un enlace de descarga",
          details: signed,
        },
        {
          status: 500,
        }
      );
    }

    const downloadUrl =
      signedUrl.startsWith("http")
        ? signedUrl
        : `${env.PUBLIC_SUPABASE_URL}/storage/v1${signedUrl}`;

    return Response.json({
      ok: true,
      url: downloadUrl,
      expiresIn: 300,
    });
  } catch (error) {
    console.error(
      "Error en download.js:",
      error
    );

    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Error preparando la descarga",
      },
      {
        status: 500,
      }
    );
  }
}

export function onRequestGet() {
  return Response.json({
    ok: true,
    mensaje:
      "API de descarga protegida operativa",
  });
}