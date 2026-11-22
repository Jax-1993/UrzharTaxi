import crypto from "crypto";

function hashToken(t) { return crypto.createHash("sha256").update(String(t)).digest("hex"); }

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const action = req.query?.action || req.body?.action;
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  if (action === "online_drivers" && req.method === "GET") {
    const r = await fetch(`${URL}/rest/v1/drivers?is_online=eq.true&current_latitude=not.is.null&select=current_latitude,current_longitude,car_class`, { headers });
    const drivers = await r.json();
    return res.status(200).json({ success: true, drivers });
  }

  if (action === "location" && req.method === "POST") {
    const { orderId, trackingToken } = req.body;
    const r = await fetch(`${URL}/rest/v1/orders?id=eq.${orderId}&passenger_tracking_token_hash=eq.${hashToken(trackingToken)}&select=status,driver_current_latitude,driver_current_longitude`, { headers });
    const orders = await r.json();
    if (!orders.length) return res.status(404).json({ success: false });
    if (!orders[0].driver_current_latitude) return res.status(403).json({ success: false, message: "GPS күтілуде" });
    return res.status(200).json({ success: true, driverLocation: { latitude: orders[0].driver_current_latitude, longitude: orders[0].driver_current_longitude } });
  }

  // ЖАҢАРТЫЛҒАН STATUS: Күту уақытын есептеп қайтарады
  if (action === "status" && req.method === "POST") {
    const { orderId, trackingToken } = req.body;
    const r = await fetch(
      `${URL}/rest/v1/orders?id=eq.${orderId}&passenger_tracking_token_hash=eq.${hashToken(trackingToken)}&select=status,pickup_address,destination_address,price,car_class,driver_arrived_at,waiting_fee,waiting_minutes,free_wait_until`,
      { headers }
    );
    const orders = await r.json();
    if (!orders.length) return res.status(404).json({ success: false });

    const o = orders[0];

    // Күту ақысын нақты уақытта есептеу
    const WAIT_FREE_MS = 5 * 60 * 1000; // 5 минут
    const WAIT_RATE_PER_MIN = 10;        // 10 теңге/мин
    let liveWaiting = { minutes: 0, fee: 0, isPaid: false, freeUntil: null };

    if (o.driver_arrived_at && o.status === "accepted") {
      const arrivedMs = new Date(o.driver_arrived_at).getTime();
      if (!isNaN(arrivedMs)) {
        const freeUntilMs = arrivedMs + WAIT_FREE_MS;
        liveWaiting.freeUntil = new Date(freeUntilMs).toISOString();
        if (Date.now() >= freeUntilMs) {
          const paidMin = Math.floor((Date.now() - freeUntilMs) / 60000);
          liveWaiting.minutes = paidMin;
          liveWaiting.fee = paidMin * WAIT_RATE_PER_MIN;
          liveWaiting.isPaid = true;
        }
      }
    }

    // Егер сапар басталып кетсе немесе аяқталса — базадағы дайын соманы қолданамыз
    if (o.status === "in_progress" || o.status === "completed") {
      liveWaiting.minutes = Number(o.waiting_minutes || 0);
      liveWaiting.fee = Number(o.waiting_fee || 0);
      liveWaiting.isPaid = liveWaiting.fee > 0;
    }

    return res.status(200).json({
      success: true,
      order: {
        ...o,
        waiting: liveWaiting   // Жолаушы интерфейсі осыны қолданады
      }
    });
  }

  if (action === "cancel" && req.method === "POST") {
    const { orderId, trackingToken } = req.body;
    await fetch(`${URL}/rest/v1/orders?id=eq.${orderId}&passenger_tracking_token_hash=eq.${hashToken(trackingToken)}&status=in.(searching,accepted)`, {
      method: "PATCH", headers, body: JSON.stringify({ status: "cancelled" })
    });
    return res.status(200).json({ success: true });
  }
  return res.status(400).json({ success: false });
}
