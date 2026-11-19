import crypto from "crypto";
import { promisify } from "util";

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = "urzhar_driver_session";

function createSession(driverId, secret) {
  const expires = Date.now() + 7 * 86400000;
  const sig = crypto.createHmac("sha256", secret).update(`urzhar-driver:${driverId}:${expires}`).digest("hex");
  return `${driverId}.${expires}.${sig}`;
}

function getDriverId(req, secret) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)urzhar_driver_session=([^;]+)/);
  if (!match) return null;
  let parts;
  try { parts = decodeURIComponent(match[1]).split("."); } catch { return null; }
  if (parts.length !== 3) return null;
  const [driverId, expiresText, sig] = parts;
  const expires = Number(expiresText);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(driverId) || !Number.isFinite(expires) || expires <= Date.now() || !/^[a-f0-9]{64}$/i.test(sig)) return null;
  const expected = crypto.createHmac("sha256", secret).update(`urzhar-driver:${driverId}:${expires}`).digest("hex");
  const a = Buffer.from(sig, "hex"), b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return driverId;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string") return false;
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hash] = parts;
  const storedKey = Buffer.from(hash, "hex");
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(derived, storedKey);
}

function getAlmatyWeek(date) {
  const shifted = new Date(date.getTime() + 5 * 60 * 60 * 1000);
  const day = shifted.getUTCDay();
  const offset = (day + 6) % 7;
  const monday = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - offset));
  const start = new Date(monday.getTime() - 5 * 60 * 60 * 1000);
  return { start, end: new Date(start.getTime() + 7 * 86400000) };
}

function normalizePhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits.length === 10) digits = "7" + digits;
  return "+" + digits.slice(-11);
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) return res.status(500).json({ success: false, message: "Сервер баптауы жоқ" });

  const action = req.query?.action || req.body?.action;
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  if (action === "login" && req.method === "POST") {
    const { phone, password } = req.body || {};
    const cleanPhone = normalizePhone(phone);
    const r = await fetch(`${URL}/rest/v1/drivers?phone=eq.${encodeURIComponent(cleanPhone)}&select=id,password_hash,is_blocked,block_reason&limit=1`, { headers });
    const drivers = await r.json();
    const driver = drivers[0];
    if (!driver || !(await verifyPassword(password, driver.password_hash))) {
      return res.status(401).json({ success: false, message: "Телефон немесе құпиясөз қате" });
    }
    if (driver.is_blocked) {
      return res.status(403).json({ success: false, blocked: true, reason: driver.block_reason });
    }
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${createSession(driver.id, KEY)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
    return res.status(200).json({ success: true });
  }

  if (action === "logout") {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/`);
    return res.status(200).json({ success: true });
  }

  const driverId = getDriverId(req, KEY);
  if (!driverId) return res.status(401).json({ success: false, message: "Сессия жоқ" });

  if (action === "stats" && req.method === "GET") {
    const [oRes, cRes] = await Promise.all([
      fetch(`${URL}/rest/v1/orders?driver_id=eq.${driverId}&status=eq.completed&select=price`, { headers }),
      fetch(`${URL}/rest/v1/driver_commissions?driver_id=eq.${driverId}&select=commission_amount,status,created_at`, { headers })
    ]);
    const orders = await oRes.json(), comms = await cRes.json();
    const gross = orders.reduce((s, o) => s + Number(o.price || 0), 0);
    const commTotal = comms.reduce((s, c) => s + Number(c.commission_amount || 0), 0);
    const w = getAlmatyWeek(new Date());
    const wComms = comms.filter(c => new Date(c.created_at) >= w.start && new Date(c.created_at) < w.end);
    return res.status(200).json({
      success: true, ridesCount: orders.length, grossTotal: gross, driverEarning: gross - commTotal, commissionTotal: commTotal,
      weekly: { start: w.start.toISOString(), end: w.end.toISOString(), unpaid: wComms.filter(c=>c.status==="unpaid").reduce((s,c)=>s+Number(c.commission_amount),0), paid: wComms.filter(c=>c.status==="paid").reduce((s,c)=>s+Number(c.commission_amount),0) }
    });
  }

  if (action === "orders" && req.method === "GET") {
    const nRes = await fetch(`${URL}/rest/v1/orders?status=eq.searching&select=id,pickup_address,destination_address,car_class,distance_km,price,payment_method,created_at&order=created_at.asc`, { headers });
    // Картаға қажетті координаталарды да қосып аламыз
    const mRes = await fetch(`${URL}/rest/v1/orders?driver_id=eq.${driverId}&status=in.(accepted,in_progress)&select=id,passenger_name,passenger_phone,pickup_address,destination_address,car_class,distance_km,price,status,created_at,pickup_latitude,pickup_longitude,destination_latitude,destination_longitude&order=created_at.desc`, { headers });
    return res.status(200).json({ success: true, new_orders: await nRes.json(), my_orders: await mRes.json() });
  }

  if (action === "accept" && req.method === "POST") {
    const { orderId } = req.body;
    const r = await fetch(`${URL}/rest/v1/orders?id=eq.${orderId}&status=eq.searching&driver_id=is.null`, {
      method: "PATCH", headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ driver_id: driverId, status: "accepted", accepted_at: new Date().toISOString() })
    });
    const updated = await r.json();
    if (!updated.length) return res.status(409).json({ success: false, message: "Басқа жүргізуші қабылдап қойды" });
    return res.status(200).json({ success: true });
  }

  if (action === "start_ride" && req.method === "POST") {
    const { orderId } = req.body;
    const r = await fetch(`${URL}/rest/v1/orders?id=eq.${orderId}&driver_id=eq.${driverId}&status=eq.accepted`, {
      method: "PATCH", headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ status: "in_progress", in_progress_at: new Date().toISOString() })
    });
    const updated = await r.json();
    if (!updated.length) return res.status(409).json({ success: false, message: "Сапарды бастау мүмкін емес" });
    return res.status(200).json({ success: true });
  }

  if (action === "complete" && req.method === "POST") {
    const r = await fetch(`${URL}/rest/v1/rpc/complete_taxi_order`, {
      method: "POST", headers, body: JSON.stringify({ p_order_id: req.body.orderId, p_driver_id: driverId })
    });
    const d = await r.json();
    if (!r.ok || !d.success) return res.status(409).json({ success: false, message: d.message || "Қате" });
    return res.status(200).json(d);
  }

  if (action === "cancel" && req.method === "POST") {
    await fetch(`${URL}/rest/v1/orders?id=eq.${req.body.orderId}&driver_id=eq.${driverId}&status=in.(accepted,in_progress)`, {
      method: "PATCH", headers, body: JSON.stringify({ driver_id: null, status: "searching", accepted_at: null, in_progress_at: null })
    });
    return res.status(200).json({ success: true });
  }

  if (action === "share_location" && req.method === "POST") {
    const { latitude, longitude } = req.body;
    await fetch(`${URL}/rest/v1/orders?driver_id=eq.${driverId}&status=in.(accepted,in_progress)`, {
      method: "PATCH", headers,
      body: JSON.stringify({ driver_current_latitude: Number(latitude), driver_current_longitude: Number(longitude), driver_location_updated_at: new Date().toISOString() })
    });
    return res.status(200).json({ success: true });
  }

  if (action === "messages" && req.method === "GET") {
    const r = await fetch(`${URL}/rest/v1/driver_messages?driver_id=eq.${driverId}&order=created_at.asc&limit=200`, { headers });
    const msgs = await r.json();
    await fetch(`${URL}/rest/v1/driver_messages?driver_id=eq.${driverId}&sender_role=eq.admin&read_at=is.null`, {
      method: "PATCH", headers, body: JSON.stringify({ read_at: new Date().toISOString() })
    });
    return res.status(200).json({ success: true, messages: msgs });
  }

  if (action === "send_message" && req.method === "POST") {
    await fetch(`${URL}/rest/v1/driver_messages`, {
      method: "POST", headers, body: JSON.stringify({ driver_id: driverId, sender_role: "driver", message: req.body.message })
    });
    return res.status(201).json({ success: true });
  }

  return res.status(400).json({ success: false, message: "Белгісіз әрекет" });
}
