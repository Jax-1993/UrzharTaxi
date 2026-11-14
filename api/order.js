import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Тек POST" });

  try {
    const { from, to, car, distance, price, payment, phone, name, pickup_latitude, pickup_longitude, destination_latitude, destination_longitude } = req.body || {};
    if (!from || !to || !phone || !name || price === undefined) return res.status(400).json({ error: "Мәліметтер толық емес" });

    const URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!URL || !KEY) return res.status(500).json({ error: "Сервер баптауы жоқ" });

    const trackingToken = crypto.randomBytes(32).toString("hex");
    const trackingTokenHash = crypto.createHash("sha256").update(trackingToken).digest("hex");
    
    // Бизнес+ қатесі түзетілді
    const carClassMap = { "Эконом": "economy", "Бизнес": "comfort", "Комфорт+": "comfort_plus", "Бизнес+": "comfort_plus" };
    const carClass = carClassMap[car] || "economy";

    const orderData = {
      passenger_name: String(name).trim(), passenger_phone: String(phone).trim(),
      pickup_address: String(from).trim(), destination_address: String(to).trim(),
      car_class: carClass, distance_km: Number(distance) || null, price: Number(price),
      payment_method: payment || "cash", status: "searching",
      passenger_tracking_token_hash: trackingTokenHash
    };

    if (pickup_latitude) orderData.pickup_latitude = Number(pickup_latitude);
    if (pickup_longitude) orderData.pickup_longitude = Number(pickup_longitude);
    if (destination_latitude) orderData.destination_latitude = Number(destination_latitude);
    if (destination_longitude) orderData.destination_longitude = Number(destination_longitude);

    const r = await fetch(`${URL}/rest/v1/orders`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "return=representation" },
      body: JSON.stringify(orderData)
    });
    const dbResult = await r.json();
    if (!r.ok || !dbResult[0]?.id) return res.status(502).json({ error: "Сақтау мүмкін болмады" });

    return res.status(200).json({ success: true, orderId: dbResult[0].id, trackingToken });
  } catch (e) { return res.status(500).json({ error: "Сервер қатесі" }); }
}
