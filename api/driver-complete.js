
import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Тек POST сұранысы қабылданады"
    });
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(500).json({
        success: false,
        message: "Сервер баптауы толық емес"
      });
    }

    const cookies = (req.headers.cookie || "")
      .split(";")
      .map(item => item.trim());

    const sessionCookie = cookies.find(item =>
      item.startsWith("urzhar_driver_session=")
    );

    if (!sessionCookie) {
      return res.status(401).json({
        success: false,
        message: "Алдымен жүйеге кіріңіз"
      });
    }

    const token = decodeURIComponent(
      sessionCookie.split("=").slice(1).join("=")
    );

    const parts = token.split(".");

    if (parts.length !== 3) {
      return res.status(401).json({
        success: false,
        message: "Сессия дұрыс емес"
      });
    }

    const [driverId, expires, signature] = parts;

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      !uuidPattern.test(driverId) ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now()
    ) {
      return res.status(401).json({
        success: false,
        message: "Сессия мерзімі аяқталған"
      });
    }

    const expected = crypto
      .createHmac("sha256", SERVICE_KEY)
      .update(`${driverId}.${expires}`)
      .digest("hex");

    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return res.status(401).json({
        success: false,
        message: "Сессия расталмады"
      });
    }

    const { orderId } = req.body || {};

    if (
      typeof orderId !== "string" ||
      !uuidPattern.test(orderId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Тапсырыс нөмірі дұрыс емес"
      });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json"
    };

    // Жүргізушінің белсенділігін тексеру
    const driverResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/drivers?id=eq.${driverId}&is_active=eq.true&select=id`,
      { headers }
    );

    if (!driverResponse.ok) {
      throw new Error("Жүргізушіні тексеру қатесі");
    }

    const drivers = await driverResponse.json();

    if (!drivers.length) {
      return res.status(403).json({
        success: false,
        message: "Жүргізуші аккаунты белсенді емес"
      });
    }

    // Сапарды аяқтау және 10% комиссияны
    // бір дерекқор транзакциясында тіркеу
    const completeResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/complete_taxi_order`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_order_id: orderId,
          p_driver_id: driverId
        })
      }
    );

    const result = await completeResponse.json();

    if (!completeResponse.ok) {
      if (completeResponse.status === 400 ||
          completeResponse.status === 409) {
        return res.status(409).json({
          success: false,
          message: "Сапар табылмады немесе бұрын аяқталған"
        });
      }

      console.error("Supabase completion error:", result);

      throw new Error("Сапарды аяқтау қатесі");
    }

    return res.status(200).json({
      success: true,
      message: "Сапар аяқталды! Комиссия есепке тіркелді.",
      orderId: result.order_id,
      price: Number(result.price),
      commission: Number(result.commission),
      driverEarning: Number(result.driver_earning)
    });

  } catch (error) {
    console.error("Driver complete error:", error);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі. Қайталап көріңіз."
    });
  }
}
