import crypto from "crypto";

function hashToken(t) { return crypto.createHash("sha256").update(String(t)).digest("hex"); }

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const action = req.query?.action;
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  if (action === "location" && req.method === "POST") {
    const { orderId, trackingToken } = req.body;
    const r = await fetch(`${URL}/rest/v1/orders?id=eq.${orderId}&passenger_tracking_token_hash=eq.${hashToken(trackingToken)}&select=status,driver_current_latitude,driver_current_longitude`, { headers });
    const orders = await r.json();
    if (!orders.length) return res.status(404).json({ success: false });
    if (!orders[0].driver_current_latitude) return res.status(403).json({ success: false, message: "GPS күтілуде" });
    
    return res.status(200).json({ success: true, driverLocation: { latitude: orders[0].driver_current_latitude, longitude: orders[0].driver_current_longitude } });
  }

  if (action === "status" && req.method === "POST") {
    const { orderId, trackingToken } = req.body;
    const r = await fetch(`${URL}/rest/v1/orders?id=eq.${orderId}&passenger_tracking_token_hash=eq.${hashToken(trackingToken)}&select=status,pickup_address,destination_address,price,car_class`, { headers });
    const orders = await r.json();
    if (!orders.length) return res.status(404).json({ success: false });
    return res.status(200).json({ success: true, order: orders[0] });
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
