import { MercadoPagoConfig, Preference } from "mercadopago";

export async function onRequestPost(context) {

  const client = new MercadoPagoConfig({
    accessToken: context.env.MERCADOPAGO_ACCESS_TOKEN
  });

  const preference = new Preference(client);

  try {

    const body = await context.request.json();

    const result = await preference.create({
      body: {
        items: [
          {
            title: body.title,
            quantity: 1,
            currency_id: "CLP",
            unit_price: Number(body.price)
          }
        ]
      }
    });

    return Response.json({
      id: result.id
    });

  } catch (e) {

    return Response.json(
      {
        error: e.message
      },
      {
        status: 500
      }
    );

  }

}

export function onRequestGet() {
  return Response.json({
    ok: true,
    mensaje: "API de Mercado Pago operativa"
  });
}