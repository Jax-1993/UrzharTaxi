import crypto from "crypto";
import { promisify } from "util";

const scrypt = promisify(crypto.scrypt);

function verifyAdmin(req, password) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)urzhar_admin_session=([^;]+)/);
  if (!match) return false;
  const parts = match[1].split(".");
  if (parts.length !== 2) return false;
  const expires = Number(parts[0]);
  if (!Number.isFinite(expires) || expires <= Date.now()) return false;
  const expected = crypto.createHmac("sha256", password)
    .update("urzhar-admin:" + expires).digest("hex");
  const received = Buffer.from(parts[1], "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (received.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(received, expectedBuffer);
}

async function supabase(path, options = {}) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  if (!response.ok) { console.error("Supabase error:", data); throw new Error("Дерекқор қатесі"); }
  return data;
}

function validUUID(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

function getWeek(dateValue) {
  const date = new Date(new Date(dateValue).getTime() + 5 * 60 * 60 * 1000);
  const day = date.getUTCDay();
  const offset = (day + 6) % 7;
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset);
  const start = new Date(monday - 5 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 86400000);
  return { week_start: start.toISOString(), week_end: end.toISOString() };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const password = process.env.ADMIN_PASSWORD;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!password || !supabaseUrl || !serviceKey) {
    return res.status(500).json({ success: false, message: "Сервер баптаулары толық емес" });
  }

  const action = req.query?.action || (req.body?.action);

  // ===== LOGIN (auth-сыз) =====
  if (action === "login") {
    if (req.method !== "POST") return res.status(405).json({ success: false, message: "Тек POST" });
    const { password: submitted } = req.body || {};
    if (typeof submitted !== "string" || !submitted) {
      return res.status(400).json({ success: false, message: "Құпиясөзді енгізіңіз" });
    }
    const a = Buffer.from(submitted), b = Buffer.from(password);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ success: false, message: "Құпиясөз қате" });
    }
    const expires = Date.now() + 8 * 60 * 60 * 1000;
    const sig = crypto.createHmac("sha256", password).update("urzhar-admin:" + expires).digest("hex");
    res.setHeader("Set-Cookie", `urzhar_admin_session=${expires}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
    return res.status(200).json({ success: true, message: "Кіру сәтті" });
  }

  // ===== ALL OTHER ACTIONS NEED AUTH =====
  if (!verifyAdmin(req, password)) {
    return res.status(401).json({ success: false, message: "Әкімші жүйесіне қайта кіріңіз" });
  }

  try {
    // ===== LOGOUT =====
    if (action === "logout") {
      res.setHeader("Set-Cookie", "urzhar_admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
      return res.status(200).json({ success: true });
    }

    // ===== APPLICATIONS =====
    if (action === "applications") {
      const cleanUrl = supabaseUrl.replace(/\/$/, "");
      const r = await fetch(`${cleanUrl}/rest/v1/driver_applications?select=id,full_name,phone,car_brand,car_model,car_year,car_number,car_class,status,created_at,car_photo_path&order=created_at.desc`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
      });
      if (!r.ok) return res.status(502).json({ success: false, message: "Өтінімдерді алу мүмкін болмады" });
      const apps = await r.json();
      const result = await Promise.all(apps.map(async (a) => {
        let photoUrl = null;
        if (a.car_photo_path) {
          try {
            const pr = await fetch(`${cleanUrl}/storage/v1/object/sign/driver-cars/${a.car_photo_path}`, {
              method: "POST",
              headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ expiresIn: 300 })
            });
            if (pr.ok) {
              const pd = await pr.json();
              if (pd.signedURL) photoUrl = pd.signedURL.startsWith("http") ? pd.signedURL : `${cleanUrl}${pd.signedURL}`;
            }
          } catch (e) {}
        }
        return { ...a, photo_url: photoUrl };
      }));
      return res.status(200).json({ success: true, count: result.length, applications: result });
    }

    // ===== APPROVE / REJECT =====
    if (action === "approve" || action === "reject") {
      const { id } = req.body || {};
      if (!validUUID(id)) return res.status(400).json({ success: false, message: "ID дұрыс емес" });
      const cleanUrl = supabaseUrl.replace(/\/$/, "");

      if (action === "approve") {
        const tempPass = crypto.randomBytes(9).toString("base64url");
        const hash = await createPasswordHash(tempPass);
        const r = await fetch(`${cleanUrl}/rest/v1/rpc/approve_driver_application`, {
          method: "POST",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ p_application_id: id, p_password_hash: hash })
        });
        if (!r.ok) return res.status(502).json({ success: false, message: "Мақұлдау қатесі" });
        const result = await r.json();
        if (!result?.success || !result?.driver_id) return res.status(502).json({ success: false, message: "Нәтиже қате" });
        return res.status(200).json({ success: true, message: "Мақұлданды", temporary_password: tempPass, driver_id: result.driver_id });
      }

      const r = await fetch(`${cleanUrl}/rest/v1/driver_applications?id=eq.${id}&status=eq.pending`, {
        method: "PATCH",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ status: "rejected" })
      });
      if (!r.ok) return res.status(502).json({ success: false, message: "Қабылдамау қатесі" });
      const updated = await r.json();
      if (!updated.length) return res.status(404).json({ success: false, message: "Өтінім табылмады" });
      return res.status(200).json({ success: true, message: "Өтінім қабылданбады" });
    }

    // ===== DRIVER MANAGEMENT =====
    if (["block_driver", "unblock_driver", "delete_driver"].includes(action)) {
      const { driver_id } = req.body || {};
      if (!validUUID(driver_id)) return res.status(400).json({ success: false, message: "ID дұрыс емес" });
      const cleanUrl = supabaseUrl.replace(/\/$/, "");
      const updateData = {};
      if (action === "block_driver") updateData.is_blocked = true;
      if (action === "unblock_driver") updateData.is_blocked = false;
      if (action === "delete_driver") { updateData.is_blocked = true; updateData.deleted_at = new Date().toISOString(); }
      const r = await fetch(`${cleanUrl}/rest/v1/drivers?id=eq.${driver_id}&deleted_at=is.null`, {
        method: "PATCH",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(updateData)
      });
      if (!r.ok) return res.status(502).json({ success: false, message: "Басқару қатесі" });
      const updated = await r.json();
      if (!updated.length) return res.status(404).json({ success: false, message: "Жүргізуші табылмады" });
      return res.status(200).json({ success: true, action });
    }

    // ===== COMMISSIONS (GET) =====
    if (action === "commissions" && req.method === "GET") {
      const [commissions, drivers, unreadRows] = await Promise.all([
        supabase("driver_commissions?select=id,driver_id,order_id,ride_price,commission_amount,status,created_at,paid_at&order=created_at.desc&limit=5000"),
        supabase("drivers?select=id,full_name,phone,is_blocked,deleted_at"),
        supabase("driver_messages?select=driver_id&sender_role=eq.driver&read_at=is.null&limit=10000")
      ]);
      const unreadCounts = {};
      for (const row of unreadRows || []) unreadCounts[row.driver_id] = (unreadCounts[row.driver_id] || 0) + 1;
      const driversWithUnread = (drivers || []).map(d => ({ ...d, unread_messages: unreadCounts[d.id] || 0 }));
      const driverMap = new Map((drivers || []).map(d => [d.id, d]));
      const groups = new Map(), history = new Map();
      for (const row of commissions || []) {
        const week = getWeek(row.created_at);
        const driver = driverMap.get(row.driver_id) || {};
        const price = Number(row.ride_price || 0);
        const commission = Number(row.commission_amount || 0);
        const key = row.driver_id + "_" + week.week_start;
        if (!groups.has(key)) groups.set(key, {
          driver_id: row.driver_id, driver_name: driver.full_name || "Белгісіз", driver_phone: driver.phone || "",
          ...week, rides_count: 0, gross_total: 0, commission_total: 0, unpaid_total: 0, paid_total: 0
        });
        const g = groups.get(key);
        g.rides_count++; g.gross_total += price; g.commission_total += commission;
        if (row.status === "paid") {
          g.paid_total += commission;
          const paidAt = row.paid_at || null;
          const hk = row.driver_id + "_" + week.week_start + "_" + (paidAt || "unknown");
          if (!history.has(hk)) history.set(hk, {
            driver_id: row.driver_id, driver_name: driver.full_name || "Белгісіз", driver_phone: driver.phone || "",
            week_start: week.week_start, week_end: week.week_end, paid_at: paidAt, rides_count: 0, paid_total: 0
          });
          const p = history.get(hk); p.rides_count++; p.paid_total += commission;
        } else g.unpaid_total += commission;
      }
      const result = Array.from(groups.values()).map(g => ({
        ...g, gross_total: +g.gross_total.toFixed(2), commission_total: +g.commission_total.toFixed(2),
        unpaid_total: +g.unpaid_total.toFixed(2), paid_total: +g.paid_total.toFixed(2)
      })).sort((a, b) => b.week_start.localeCompare(a.week_start));
      const paymentHistory = Array.from(history.values()).map(p => ({ ...p, paid_total: +p.paid_total.toFixed(2) }))
        .sort((a, b) => (b.paid_at || "").localeCompare(a.paid_at || ""));
      return res.status(200).json({ success: true, commissions: result, payment_history: paymentHistory, drivers: driversWithUnread });
    }

    // ===== MESSAGES (GET) =====
    if (action === "messages" && req.method === "GET") {
      const driverId = req.query?.driver_id;
      if (!validUUID(driverId)) return res.status(400).json({ success: false, message: "ID қате" });
      const messages = await supabase(`driver_messages?select=id,driver_id,sender_role,message_type,message,created_at,read_at&driver_id=eq.${driverId}&order=created_at.asc&limit=200`);
      const unread = (messages || []).filter(m => m.sender_role === "driver" && !m.read_at);
      if (unread.length > 0) {
        const now = new Date().toISOString();
        await supabase(`driver_messages?driver_id=eq.${driverId}&sender_role=eq.driver&read_at=is.null`, {
          method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ read_at: now })
        });
        for (const m of messages) if (m.sender_role === "driver" && !m.read_at) m.read_at = now;
      }
      return res.status(200).json({ success: true, messages: messages || [] });
    }

    // ===== SEND MESSAGE =====
    if (action === "send_message") {
      const { driver_id, message, message_type = "text" } = req.body || {};
      if (!validUUID(driver_id)) return res.status(400).json({ success: false, message: "ID қате" });
      const msg = String(message || "").trim();
      if (!msg || msg.length > 2000) return res.status(400).json({ success: false, message: "1–2000 таңба" });
      if (!["text", "admin_notice"].includes(message_type)) return res.status(400).json({ success: false, message: "Түрі қате" });
      const d = await supabase(`drivers?select=id&id=eq.${driver_id}&limit=1`);
      if (!d || d.length === 0) return res.status(404).json({ success: false, message: "Жүргізуші табылмады" });
      const saved = await supabase("driver_messages", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ driver_id, sender_role: "admin", message_type, message: msg })
      });
      return res.status(200).json({ success: true, data: saved?.[0] || null });
    }

    // ===== MARK PAID =====
    if (action === "mark_paid") {
      const { driver_id, week_start, week_end } = req.body || {};
      const start = Date.parse(week_start), end = Date.parse(week_end);
      if (!validUUID(driver_id) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 7 * 86400000 + 1000) {
        return res.status(400).json({ success: false, message: "Апта деректері қате" });
      }
      const query = `driver_id=eq.${driver_id}&status=eq.unpaid&created_at=gte.${encodeURIComponent(week_start)}&created_at=lt.${encodeURIComponent(week_end)}`;
      const updated = await supabase(`driver_commissions?${query}`, {
        method: "PATCH", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() })
      });
      if (!updated || updated.length === 0) return res.status(409).json({ success: false, message: "Төленбеген комиссия табылмады" });
      const total = updated.reduce((s, r) => s + Number(r.commission_amount || 0), 0);
      return res.status(200).json({ success: true, rides_count: updated.length, commission_paid: +total.toFixed(2) });
    }

    return res.status(400).json({ success: false, message: "Белгісіз әрекет: " + action });
  } catch (e) {
    console.error("Admin error:", e);
    return res.status(500).json({ success: false, message: "Сервер қатесі" });
  }
}
