import crypto from "crypto";
import { promisify } from "util";
const scrypt = promisify(crypto.scrypt);

function verifyAdmin(req, password) {
  const match = (req.headers.cookie || "").match(/(?:^|;\s*)urzhar_admin_session=([^;]+)/);
  if (!match) return false;
  const [expires, sig] = match[1].split(".");
  if (Number(expires) <= Date.now()) return false;
  const expected = crypto.createHmac("sha256", password).update("urzhar-admin:" + expires).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const password = process.env.ADMIN_PASSWORD;
  const URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const action = req.query?.action || req.body?.action;
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  if (action === "login" && req.method === "POST") {
    if (req.body.password !== password) return res.status(401).json({ success: false, message: "Қате" });
    const expires = Date.now() + 8 * 3600000;
    const sig = crypto.createHmac("sha256", password).update("urzhar-admin:" + expires).digest("hex");
    res.setHeader("Set-Cookie", `urzhar_admin_session=${expires}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
    return res.status(200).json({ success: true });
  }

  if (!verifyAdmin(req, password)) return res.status(401).json({ success: false, message: "Рұқсат жоқ" });

  if (action === "applications" && req.method === "GET") {
    const r = await fetch(`${URL}/rest/v1/driver_applications?status=eq.pending&select=*`, { headers });
    const apps = await r.json();
    const withPhotos = await Promise.all(apps.map(async a => {
      let photo_url = null;
      if (a.car_photo_path) {
        const pr = await fetch(`${URL}/storage/v1/object/sign/driver-cars/${a.car_photo_path}`, { method: "POST", headers, body: JSON.stringify({ expiresIn: 3600 }) });
        const pd = await pr.json();
        if (pd.signedURL) photo_url = pd.signedURL.startsWith("http") ? pd.signedURL : `${URL}${pd.signedURL}`;
      }
      return { ...a, photo_url };
    }));
    return res.status(200).json({ success: true, applications: withPhotos });
  }

  if (action === "approve" && req.method === "POST") {
    const tempPass = crypto.randomBytes(4).toString("hex");
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = `scrypt$${salt}$${(await scrypt(tempPass, salt, 64)).toString("hex")}`;
    const r = await fetch(`${URL}/rest/v1/rpc/approve_driver_application`, { method: "POST", headers, body: JSON.stringify({ p_application_id: req.body.id, p_password_hash: hash }) });
    const d = await r.json();
    return res.status(200).json({ success: true, temporary_password: tempPass, driver_id: d.driver_id });
  }

  if (action === "reject" && req.method === "POST") {
    await fetch(`${URL}/rest/v1/driver_applications?id=eq.${req.body.id}`, { method: "PATCH", headers, body: JSON.stringify({ status: "rejected" }) });
    return res.status(200).json({ success: true });
  }

  if (action === "drivers" && req.method === "GET") {
    const r = await fetch(`${URL}/rest/v1/drivers?select=id,full_name,phone,is_blocked,deleted_at`, { headers });
    return res.status(200).json({ success: true, drivers: await r.json() });
  }

  if (["block_driver", "unblock_driver", "delete_driver"].includes(action)) {
    const data = action === "block_driver" ? { is_blocked: true } : action === "unblock_driver" ? { is_blocked: false } : { is_blocked: true, deleted_at: new Date().toISOString() };
    await fetch(`${URL}/rest/v1/drivers?id=eq.${req.body.driver_id}`, { method: "PATCH", headers, body: JSON.stringify(data) });
    return res.status(200).json({ success: true });
  }

  if (action === "commissions" && req.method === "GET") {
    const [cRes, dRes] = await Promise.all([
      fetch(`${URL}/rest/v1/driver_commissions?select=*,drivers(full_name,phone)`, { headers }),
      fetch(`${URL}/rest/v1/drivers?select=id,full_name,phone`, { headers })
    ]);
    return res.status(200).json({ success: true, commissions: await cRes.json(), drivers: await dRes.json() });
  }

  if (action === "mark_paid" && req.method === "POST") {
    const q = `driver_id=eq.${req.body.driver_id}&status=eq.unpaid&created_at=gte.${req.body.week_start}&created_at=lt.${req.body.week_end}`;
    await fetch(`${URL}/rest/v1/driver_commissions?${q}`, { method: "PATCH", headers, body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }) });
    return res.status(200).json({ success: true });
  }

  if (action === "messages" && req.method === "GET") {
    const r = await fetch(`${URL}/rest/v1/driver_messages?driver_id=eq.${req.query.driver_id}&order=created_at.asc&limit=200`, { headers });
    return res.status(200).json({ success: true, messages: await r.json() });
  }

  if (action === "send_message" && req.method === "POST") {
    await fetch(`${URL}/rest/v1/driver_messages`, { method: "POST", headers, body: JSON.stringify({ driver_id: req.body.driver_id, sender_role: "admin", message: req.body.message }) });
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ success: false });
}
