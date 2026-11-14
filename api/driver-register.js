import { randomUUID } from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Тек POST" });
  const { full_name, phone, car_brand, car_model, car_year, car_number, car_class, car_photo_base64, car_photo_type } = req.body || {};
  
  if (!full_name || !phone || !car_brand || !car_model || !car_number || !car_photo_base64) return res.status(400).json({ success: false, error: "Мәліметтер толық емес" });

  const URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) return res.status(500).json({ success: false, error: "Сервер баптауы жоқ" });

  const base64 = car_photo_base64.replace(/^data:image\/\w+;base64,/, "");
  const photoBuffer = Buffer.from(base64, "base64");
  const photoPath = `${randomUUID()}.jpg`;

  try {
    const upRes = await fetch(`${URL}/storage/v1/object/driver-cars/${photoPath}`, {
      method: "POST", headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "image/jpeg" }, body: photoBuffer
    });
    if (!upRes.ok) throw new Error("Фото жүктелмеді");

    const dbRes = await fetch(`${URL}/rest/v1/driver_applications`, {
      method: "POST", headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ full_name, phone, car_brand, car_model, car_year: car_year ? Number(car_year) : null, car_number: car_number.toUpperCase(), car_class, car_photo_path: photoPath, status: "pending" })
    });
    
    if (!dbRes.ok) {
      await fetch(`${URL}/storage/v1/object/driver-cars/${photoPath}`, { method: "DELETE", headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
      return res.status(400).json({ success: false, error: "Өтінім сақталмады (телефон бұрын тіркелген болуы мүмкін)" });
    }
    return res.status(201).json({ success: true });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
}
