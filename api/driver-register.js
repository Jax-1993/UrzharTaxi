import { randomUUID } from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Тек POST" });
  const { 
    full_name, phone, car_brand, car_model, car_year, car_number, car_class, 
    car_photo_base64, id_front_base64, id_back_base64, license_base64, selfie_base64 
  } = req.body || {};
  
  if (!full_name || !phone || !car_brand || !car_model || !car_number || 
      !car_photo_base64 || !id_front_base64 || !id_back_base64 || !license_base64 || !selfie_base64) {
    return res.status(400).json({ success: false, error: "Барлық мәліметтер мен суреттер толық емес" });
  }

  const URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) return res.status(500).json({ success: false, error: "Сервер баптауы жоқ" });

  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits.length === 10) digits = "7" + digits;
  const cleanPhone = "+" + digits.slice(-11);

  // Суреттерді дайындау
  const files = [
    { key: 'car_photo_path', base64: car_photo_base64 },
    { key: 'id_card_front_path', base64: id_front_base64 },
    { key: 'id_card_back_path', base64: id_back_base64 },
    { key: 'driver_license_path', base64: license_base64 },
    { key: 'selfie_path', base64: selfie_base64 }
  ];

  const uploadedPaths = [];

  try {
    // Барлық суреттерді Supabase Storage-қа жүктеу
    for (const file of files) {
      const base64Data = file.base64.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      const fileName = `${randomUUID()}.jpg`;
      
      const upRes = await fetch(`${URL}/storage/v1/object/driver-cars/${fileName}`, {
        method: "POST", 
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "image/jpeg" }, 
        body: buffer
      });
      
      if (!upRes.ok) throw new Error("Суреттерді жүктеу мүмкін болмады");
      file.path = fileName; // Сақтау үшін жолды есте қалдыру
      uploadedPaths.push(fileName);
    }

    // Дерекқорға сақтау
    const dbRes = await fetch(`${URL}/rest/v1/driver_applications`, {
      method: "POST", headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        full_name, 
        phone: cleanPhone,
        car_brand, car_model, car_year: car_year ? Number(car_year) : null, 
        car_number: car_number.toUpperCase(), car_class, 
        car_photo_path: files[0].path,
        id_card_front_path: files[1].path,
        id_card_back_path: files[2].path,
        driver_license_path: files[3].path,
        selfie_path: files[4].path,
        status: "pending" 
      })
    });
    
    if (!dbRes.ok) {
      throw new Error("Өтінім сақталмады (телефон бұрын тіркелген болуы мүмкін)");
    }

    return res.status(201).json({ success: true });

  } catch (e) { 
    // Егер қате болса, жүктелген суреттерді өшіру (тазалау)
    for (const path of uploadedPaths) {
      await fetch(`${URL}/storage/v1/object/driver-cars/${path}`, { method: "DELETE", headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    }
    return res.status(500).json({ success: false, error: e.message }); 
  }
}
