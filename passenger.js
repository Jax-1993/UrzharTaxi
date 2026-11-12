import crypto from "crypto";

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function validUUID(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) {
    return res.status(500).json({ success: false, message: "Сервер баптауы толық емес" });
  }

  const action = req.query?.action;
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json"
  };

  try {
    // ===== ЖҮРГІЗУШІНІҢ GPS ОРНЫН АЛУ =====
    if (action === "location" && req.method === "POST") {
      const { orderId, trackingToken } = req.body || {};

      if (!validUUID(orderId)) {
        return res.status(400).json({ success: false, message: "Тапсырыс ID дұрыс емес" });
      }
      if (typeof trackingToken !== "string" || !/^[a-f0-9]{64}$/i.test(trackingToken)) {
        return res.status(400).json({ success: false, message: "Tracking токен дұрыс емес" });
      }

      const tokenHash = hashToken(trackingToken);
      const r = await fetch(
        `${URL}/rest/v1/orders?id=eq.${orderId}&passenger_tracking_token_hash=eq.${tokenHash}` +
        `&select=id,status,driver_id,driver_current_latitude,driver_current_longitude,driver_location_updated_at&limit=1`,
        { headers }
      );

      if (!r.ok) return res.status(502).json({ success: false, message: "Дерекқор қатесі" });
      const orders = await r.json();
      const order = orders[0];

      if (!order) {
        return res.status(404).json({ success: false, message: "Тапсырыс табылмады" });
      }

      if (!order.driver_id) {
        return res.status(403).json({
          success: false,
          message: "Жүргізуші әлі тағайындалмаған",
          status: order.status
        });
      }

      if (order.driver_current_latitude == null || order.driver_current_longitude == null) {
        return res.status(403).json({
          success: false,
          message: "Жүргізуші GPS бөлісуді бастамаған",
          status: order.status
        });
      }

      // Ескі GPS — 2 минуттан асса, ескерту
      const updatedAt = order.driver_location_updated_at
        ? new Date(order.driver_location_updated_at).getTime()
        : 0;
      const isStale = Date.now() - updatedAt > 2 * 60 * 1000;

      return res.status(200).json({
        success: true,
        status: order.status,
        stale: isStale,
        driverLocation: {
          latitude: Number(order.driver_current_latitude),
          longitude: Number(order.driver_current_longitude),
          updatedAt: order.driver_location_updated_at
        }
      });
    }

    // ===== САПАРДАН БАС ТАРТУ (жолаушы) =====
    if (action === "cancel" && req.method === "POST") {
      const { orderId, trackingToken } = req.body || {};

      if (!validUUID(orderId)) {
        return res.status(400).json({ success: false, message: "Тапсырыс ID дұрыс емес" });
      }
      if (typeof trackingToken !== "string" || !/^[a-f0-9]{64}$/i.test(trackingToken)) {
        return res.status(400).json({ success: false, message: "Tracking токен дұрыс емес" });
      }

      const tokenHash = hashToken(trackingToken);
      // Тек searching немесе accepted күйінде ғана бас тартуға болады
      const r = await fetch(
        `${URL}/rest/v1/orders?id=eq.${orderId}&passenger_tracking_token_hash=eq.${tokenHash}` +
        `&status=in.(searching,accepted)`,
        {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=representation" },
          body: JSON.stringify({ status: "cancelled", updated_at: new Date().toISOString() })
        }
      );

      if (!r.ok) return res.status(500).json({ success: false, message: "Бас тарту қатесі" });
      const updated = await r.json().catch(() => []);

      if (!updated.length) {
        return res.status(404).json({
          success: false,
          message: "Тапсырыс табылмады немесе аяқталған/бұрын тоқтатылған"
        });
      }

      return res.status(200).json({
        success: true,
        message: "Тапсырыстан бас тартылды",
        order: updated[0]
      });
    }

    // ===== ТАПСЫРЫС КҮЙІН ТЕКСЕРУ =====
    if (action === "status" && req.method === "POST") {
      const { orderId, trackingToken } = req.body || {};

      if (!validUUID(orderId)) {
        return res.status(400).json({ success: false, message: "Тапсырыс ID дұрыс емес" });
      }

      const tokenHash = hashToken(trackingToken);
      const r = await fetch(
        `${URL}/rest/v1/orders?id=eq.${orderId}&passenger_tracking_token_hash=eq.${tokenHash}` +
        `&select=id,status,driver_id,pickup_address,destination_address,price,car_class,created_at&limit=1`,
        { headers }
      );

      if (!r.ok) return res.status(502).json({ success: false, message: "Дерекқор қатесі" });
      const orders = await r.json();

      if (!orders.length) {
        return res.status(404).json({ success: false, message: "Тапсырыс табылмады" });
      }

      return res.status(200).json({ success: true, order: orders[0] });
    }

    return res.status(400).json({
      success: false,
      message: "Белгісіз әрекет. location, cancel немесе status қолданыңыз."
    });

  } catch (e) {
    console.error("Passenger error:", e);
    return res.status(500).json({ success: false, message: "Сервер қатесі" });
  }
}
