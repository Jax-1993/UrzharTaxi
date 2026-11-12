import crypto from "crypto";
import { promisify } from "util";

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = "urzhar_driver_session";
const SESSION_DAYS = 7;

function createSession(driverId, secret) {
  const expires = Date.now() + SESSION_DAYS * 86400000;
  const sig = crypto.createHmac("sha256", secret)
    .update(`urzhar-driver:${driverId}:${expires}`).digest("hex");
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
  const expected = crypto.createHmac("sha256", secret)
    .update(`urzhar-driver:${driverId}:${expires}`).digest("hex");
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
  if (storedKey.length !== 64) return false;
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(derived, storedKey);
}

async function dbGet(url, key) {
  const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" } });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error("Дерекқор қатесі");
  return data;
}

function getAlmatyWeek(date) {
  const shifted = new Date(date.getTime() + 5 * 60 * 60 * 1000);
  const day = shifted.getUTCDay();
  const offset = (day + 6) % 7;
  const monday = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - offset));
  const start = new Date(monday.getTime() - 5 * 60 * 60 * 1000);
  return { start, end: new Date(start.getTime() + 7 * 86400000) };
}

function addOrderDateTime(order) {
  if (!order.created_at) return { ...order, order_date: null, order_time: null };
  const d = new Date(order.created_at);
  if (Number.isNaN(d.getTime())) return { ...order, order_date: null, order_time: null };
  return {
    ...order,
    order_date: new Intl.DateTimeFormat("kk-KZ", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric" }).format(d),
    order_time: new Intl.DateTimeFormat("kk-KZ", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)
  };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) return res.status(500).json({ success: false, message: "Сервер баптауы толық емес" });

  const action = req.query?.action || req.body?.action;
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  // ===== LOGIN =====
  if (action === "login") {
    if (req.method !== "POST") return res.status(405).json({ success: false, message: "Тек POST" });
    const { phone, password } = req.body || {};
    if (typeof phone !== "string" || typeof password !== "string" || !phone.trim() || !password || password.length > 200) {
      return res.status(400).json({ success: false, message: "Телефон мен құпиясөзді енгізіңіз" });
    }
    const r = await fetch(`${URL}/rest/v1/drivers?phone=eq.${encodeURIComponent(phone.trim())}&select=id,full_name,phone,password_hash,is_blocked,block_reason&limit=1`, { headers });
    if (!r.ok) return res.status(502).json({ success: false, message: "Дерекқор қатесі" });
    const drivers = await r.json();
    const driver = drivers[0];
    if (!driver || !driver.password_hash) return res.status(401).json({ success: false, message: "Телефон немесе құпиясөз қате" });
    const valid = await verifyPassword(password, driver.password_hash);
    if (!valid) return res.status(401).json({ success: false, message: "Телефон немесе құпиясөз қате" });
    if (driver.is_blocked === true) {
      res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
      return res.status(403).json({ success: false, blocked: true, message: "Аккаунтыңыз бұғатталған", reason: driver.block_reason || "Әкімшіге хабарласыңыз" });
    }
    const token = createSession(driver.id, KEY);
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
    return res.status(200).json({ success: true, message: "Кіру сәтті", driver: { id: driver.id, full_name: driver.full_name, phone: driver.phone } });
  }

  // ===== LOGOUT =====
  if (action === "logout") {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    return res.status(200).json({ success: true });
  }

  // ===== ALL OTHER ACTIONS NEED AUTH =====
  const driverId = getDriverId(req, KEY);
  if (!driverId) return res.status(401).json({ success: false, message: "Сессия расталмады. Қайта кіріңіз." });

  try {
    // Verify driver exists and not blocked
    const drivers = await dbGet(`${URL}/rest/v1/drivers?id=eq.${driverId}&select=id,full_name,phone,car_brand,car_model,car_number,car_class,is_blocked,block_reason,deleted_at&limit=1`, KEY);
    const driver = drivers?.[0];
    if (!driver || driver.deleted_at) {
      res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
      return res.status(401).json({ success: false, message: "Жүргізуші табылмады" });
    }
    if (driver.is_blocked === true) {
      res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
      return res.status(403).json({ success: false, blocked: true, message: "Аккаунтыңыз бұғатталған", reason: driver.block_reason || "Әкімшіге хабарласыңыз" });
    }

    // ===== SESSION =====
    if (action === "session") {
      return res.status(200).json({ success: true, driver });
    }

    // ===== ORDERS =====
    if (action === "orders") {
      const newUrl = new URL(`${URL}/rest/v1/orders`);
      newUrl.searchParams.set("status", "eq.searching");
      newUrl.searchParams.set("select", "id,pickup_address,destination_address,car_class,distance_km,price,payment_method,status,created_at,pickup_latitude,pickup_longitude,destination_latitude,destination_longitude");
      newUrl.searchParams.set("order", "created_at.asc");
      newUrl.searchParams.set("limit", "100");

      const myUrl = new URL(`${URL}/rest/v1/orders`);
      myUrl.searchParams.set("driver_id", `eq.${driverId}`);
      myUrl.searchParams.set("status", "in.(accepted,in_progress,completed)");
      myUrl.searchParams.set("select", "id,passenger_name,passenger_phone,pickup_address,destination_address,car_class,distance_km,price,payment_method,status,created_at,accepted_at");
      myUrl.searchParams.set("order", "created_at.desc");
      myUrl.searchParams.set("limit", "100");

      const [newOrders, myOrders] = await Promise.all([dbGet(newUrl.toString(), KEY), dbGet(myUrl.toString(), KEY)]);
      return res.status(200).json({
        success: true, driver: { id: driver.id, full_name: driver.full_name },
        new_orders: newOrders.map(addOrderDateTime), my_orders: myOrders.map(addOrderDateTime)
      });
    }

    // ===== STATS =====
    if (action === "stats") {
      const [ordersRes, commRes] = await Promise.all([
        fetch(`${URL}/rest/v1/orders?driver_id=eq.${driverId}&status=eq.completed&select=price,created_at`, { headers }),
        fetch(`${URL}/rest/v1/driver_commissions?driver_id=eq.${driverId}&select=commission_amount,status,created_at,paid_at&order=created_at.desc`, { headers })
      ]);
      if (!ordersRes.ok || !commRes.ok) throw new Error("Статистика қатесі");
      const orders = await ordersRes.json(), commissions = await commRes.json();
      const gross = orders.reduce((s, o) => s + Number(o.price || 0), 0);
      const commissionTotal = commissions.reduce((s, c) => s + Number(c.commission_amount || 0), 0);
      const w = getAlmatyWeek(new Date());
      const weekly = commissions.filter(c => { const d = new Date(c.created_at); return d >= w.start && d < w.end; });
      const unpaid = weekly.filter(c => c.status === "unpaid").reduce((s, c) => s + Number(c.commission_amount || 0), 0);
      const paid = weekly.filter(c => c.status === "paid").reduce((s, c) => s + Number(c.commission_amount || 0), 0);
      return res.status(200).json({
        success: true, ridesCount: orders.length,
        grossTotal: +gross.toFixed(2), commissionTotal: +commissionTotal.toFixed(2),
        driverEarning: +(gross - commissionTotal).toFixed(2),
        weekly: { start: w.start.toISOString(), end: w.end.toISOString(), unpaid: +unpaid.toFixed(2), paid: +paid.toFixed(2) }
      });
    }

    // ===== MESSAGES (GET) =====
    if (action === "messages" && req.method === "GET") {
      const r = await fetch(`${URL}/rest/v1/driver_messages?driver_id=eq.${driverId}&select=id,sender_role,message_type,message,created_at,read_at&order=created_at.asc&limit=200`, { headers });
      if (!r.ok) throw new Error("Хабарламалар қатесі");
      const messages = await r.json();
      const unreadCount = messages.filter(m => m.sender_role === "admin" && !m.read_at).length;
      return res.status(200).json({ success: true, messages, unreadCount });
    }

    // ===== SEND MESSAGE =====
    if (action === "send_message") {
      const msg = String(req.body?.message || "").trim();
      const type = req.body?.message_type || "text";
      if (!["text", "payment_report"].includes(type)) return res.status(400).json({ success: false, message: "Түрі дұрыс емес" });
      if (!msg || msg.length > 2000) return res.status(400).json({ success: false, message: "1–2000 таңба" });
      const r = await fetch(`${URL}/rest/v1/driver_messages`, {
        method: "POST", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ driver_id: driverId, sender_role: "driver", message_type: type, message: msg })
      });
      if (!r.ok) throw new Error("Сақтау қатесі");
      const saved = await r.json();
      return res.status(201).json({ success: true, data: saved[0] || null });
    }

    // ===== MARK READ =====
    if (action === "mark_read") {
      const r = await fetch(`${URL}/rest/v1/driver_messages?driver_id=eq.${driverId}&sender_role=eq.admin&read_at=is.null`, {
        method: "PATCH", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ read_at: new Date().toISOString() })
      });
      if (!r.ok) throw new Error("Белгілеу қатесі");
      const updated = await r.json();
      return res.status(200).json({ success: true, updatedCount: updated.length });
    }

    // ===== ACCEPT ORDER =====
    if (action === "accept") {
      const { orderId } = req.body || {};
      if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)) {
        return res.status(400).json({ success: false, message: "ID дұрыс емес" });
      }
      const r = await fetch(`${URL}/rest/v1/orders?id=eq.${orderId}&status=eq.searching&driver_id=is.null`, {
        method: "PATCH", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ driver_id: driverId, status: "accepted", accepted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      });
      const accepted = await r.json().catch(() => []);
      if (!r.ok) return res.status(500).json({ success: false, message: "Қабылдау қатесі" });
      if (!accepted.length) return res.status(409).json({ success: false, message: "Басқа жүргізуші қабылдаған немесе қолжетімсіз" });
      return res.status(200).json({ success: true, message: "Тапсырыс сізге бекітілді!", order: accepted[0] });
    }

    // ===== COMPLETE ORDER =====
    if (action === "complete") {
      const { orderId } = req.body || {};
      if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)) {
        return res.status(400).json({ success: false, message: "ID дұрыс емес" });
      }
      const r = await fetch(`${URL}/rest/v1/rpc/complete_taxi_order`, {
        method: "POST", headers,
        body: JSON.stringify({ p_order_id: orderId, p_driver_id: driverId })
      });
      const result = await r.json();
      if (!r.ok) return res.status(409).json({ success: false, message: result.message || result.details || "Аяқтау мүмкін болмады" });
      return res.status(200).json({
        success: true, message: "Сапар аяқталды!",
        orderId: result.order_id, price: Number(result.price),
        commission: Number(result.commission), driverEarning: Number(result.driver_earning)
      });
    }

    // ===== CANCEL ORDER (driver-side) =====
    if (action === "cancel") {
      const { orderId } = req.body || {};
      if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)) {
        return res.status(400).json({ success: false, message: "ID дұрыс емес" });
      }
      // Тапсырысты "searching" күйіне қайтару (басқа жүргізуші ала алады)
      const r = await fetch(`${URL}/rest/v1/orders?id=eq.${orderId}&driver_id=eq.${driverId}&status=in.(accepted,in_progress)`, {
        method: "PATCH", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ driver_id: null, status: "searching", accepted_at: null, updated_at: new Date().toISOString() })
      });
      const updated = await r.json().catch(() => []);
      if (!r.ok) return res.status(500).json({ success: false, message: "Бас тарту қатесі" });
      if (!updated.length) return res.status(409).json({ success: false, message: "Белсенді сапар табылмады" });
      return res.status(200).json({ success: true, message: "Тапсырыстан бас тартылды", order: updated[0] });
    }

    return res.status(400).json({ success: false, message: "Белгісіз әрекет: " + action });
  } catch (e) {
    console.error("Driver error:", e);
    return res.status(500).json({ success: false, message: "Сервер қатесі" });
  }
}
