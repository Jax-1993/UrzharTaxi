
import crypto from "crypto";

function getDriverId(req, secret) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(
    /(?:^|;\s*)urzhar_driver_session=([^;]+)/
  );

  if (!match) return null;

  let token;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [driverId, expires, signature] = parts;

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (
    !uuid.test(driverId) ||
    !/^\d+$/.test(expires) ||
    Number(expires) <= Date.now() ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) return null;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`urzhar-driver:${driverId}:${expires}`)
    .digest("hex");

  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) return null;

  return driverId;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Тек POST сұранысы қабылданады"
    });
  }

  try {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!baseUrl || !key) {
      return res.status(500).json({
        success: false,
        message: "Сервер баптауы толық емес"
      });
    }

    const driverId = getDriverId(req, key);

    if (!driverId) {
      return res.status(401).json({
        success: false,
        message: "Жүргізуші сессиясы расталмады. Қайта кіріңіз."
      });
    }

    const { orderId } = req.body || {};

    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (typeof orderId !== "string" || !uuid.test(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Тапсырыс нөмірі дұрыс емес"
      });
    }

    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    };

    const driverResponse = await fetch(
      `${baseUrl}/rest/v1/drivers?id=eq.${driverId}&select=id`,
      { headers }
    );

    if (!driverResponse.ok) {
      throw new Error("Жүргізушіні тексеру қатесі");
    }

    const drivers = await driverResponse.json();

    if (!drivers.length) {
      return res.status(403).json({
        success: false,
        message: "Жүргізуші табылмады"
      });
    }

    const acceptResponse = await fetch(
      `${baseUrl}/rest/v1/orders?id=eq.${orderId}&status=eq.searching&driver_id=is.null`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          driver_id: driverId,
          status: "accepted",
          accepted_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      }
    );

    const acceptedOrders = await acceptResponse.json().catch(() => []);

    if (!acceptResponse.ok) {
      console.error("Accept error:", acceptedOrders);

      return res.status(500).json({
        success: false,
        message: "Тапсырысты қабылдау қатесі"
      });
    }

    if (!acceptedOrders.length) {
      return res.status(409).json({
        success: false,
        message: "Бұл тапсырысты басқа жүргізуші қабылдаған немесе тапсырыс қолжетімсіз"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Тапсырыс сізге бекітілді!",
      order: acceptedOrders[0]
    });

  } catch (error) {
    console.error("Driver accept error:", error);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі. Қайталап көріңіз."
    });
  }
}
