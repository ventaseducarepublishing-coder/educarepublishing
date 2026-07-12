const productos = {
  recien_nacido: {
    title: "Cuidados del Recién Nacido",
    price: 9990,
  },
  sopas_caseras: {
    title: "Sopas Caseras",
    price: 7990,
  },
  lactancia_materna: {
    title: "Lactancia Materna",
    price: 8990,
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
    if (!env.MERCADOPAGO_ACCESS_TOKEN) {
      return Response.json(
        { error: "Falta configurar el Access Token" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const producto = productos[body.productId];

    if (!producto) {
      return Response.json(
        { error: "Producto no válido" },
        { status: 400 }
      );
    }

    const mpResponse = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [
            {
              id: body.productId,
              title: producto.title,
              quantity: 1,
              currency_id: "CLP",
              unit_price: producto.price,
            },
          ],
          external_reference: body.productId,
          back_urls: {
            success: "https://educarepublishing.cl/pago-exitoso",
            failure: "https://educarepublishing.cl/pago-fallido",
            pending: "https://educarepublishing.cl/pago-pendiente",
          },
          auto_return: "approved",
        }),
      }
    );

    const data = await mpResponse.json();

    if (!mpResponse.ok) {
      return Response.json(
        {
          error: "Mercado Pago rechazó la solicitud",
          details: data,
        },
        { status: mpResponse.status }
      );
    }

    return Response.json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
    });
  } catch (error) {
    return Response.json(
      {
        error: "No fue posible crear el pago",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}