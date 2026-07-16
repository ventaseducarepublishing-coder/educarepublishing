export async function onRequestPost({ request, env }) {
  try {
    const authorization = request.headers.get("Authorization") || "";

    const accessToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!accessToken) {
      return Response.json(
        { error: "No autorizado" },
        { status: 401 }
      );
    }

    const { productId } = await request.json();

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

    if (!user.id) {
      return Response.json(
        { error: "Sesión inválida" },
        { status: 401 }
      );
    }

    const purchaseResponse = await fetch(
      `${env.PUBLIC_SUPABASE_URL}/rest/v1/purchases?user_id=eq.${user.id}&product_id=eq.${productId}&status=eq.approved&select=*`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    const purchases = await purchaseResponse.json();

    if (!Array.isArray(purchases) || purchases.length === 0) {
      return Response.json(
        { error: "Compra no encontrada" },
        { status: 403 }
      );
    }

    const files = {
      recien_nacido: "recien_nacido/guia-primer-ano-bebe.pdf",
      lactancia_materna:
    "lactancia_materna/lactancia-materna.pdf",
    };

    const filePath = files[productId];

    if (!filePath) {
      return Response.json(
        { error: "Producto inválido" },
        { status: 404 }
      );
    }

    const signedResponse = await fetch(
      `${env.PUBLIC_SUPABASE_URL}/storage/v1/object/sign/ebooks/${filePath}`,
      {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expiresIn: 300,
        }),
      }
    );

    const signed = await signedResponse.json();

    if (!signedResponse.ok) {
      return Response.json(
        signed,
        {
          status: 500,
        }
      );
    }

    return Response.json({
      url:
        `${env.PUBLIC_SUPABASE_URL}/storage/v1${signed.signedURL}`,
    });
  } catch (e) {
    return Response.json(
      {
        error: e.message,
      },
      {
        status: 500,
      }
    );
  }
}