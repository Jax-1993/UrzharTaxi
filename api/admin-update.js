import crypto from "crypto";

function verifyAdmin(req, password) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)urzhar_admin_session=([^;]+)/);

  if (!match) return false;

  const parts = match[1].split(".");
  if (parts.length !== 2) return false;

  const expires = Number(parts[0]);

  if (!Number.isFinite(expires) || expires <= Date.now()) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", password)
    .update("urzhar-admin:" + expires)
    .digest("hex");

  const receivedBuffer = Buffer.from(parts[1], "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Тек POST сұранысы қабылданады"
    });
  }

  try {
    const password = process.env.ADMIN_PASSWORD;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!password || !url || !key) {
      return res.status(500).json({
        success: false,
        message: "Сервер баптаулары толық емес"
      });
    }

    if (!verifyAdmin(req, password)) {
      return res.status(401).json({
        success: false,
        message: "Әкімші рұқсаты қажет"
      });
    }

    const { id, status } = req.body || {};

    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ) {
      return res.status(400).json({
        success: false,
        message: "Өтінім ID дұрыс емес"
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Мәртебе дұрыс емес"
      });
    }

    const cleanUrl = url.replace(/\/$/, "");

    const response = await fetch(
      `${cleanUrl}/rest/v1/driver_applications?id=eq.${id}&status=eq.pending`,
      {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({ status })
      }
    );

    if (!response.ok) {
      console.error("Supabase update:", await response.text());

      return res.status(502).json({
        success: false,
        message: "Өтінімді жаңарту мүмкін болмады"
      });
    }

    const updated = await response.json();

    if (!updated.length) {
      return res.status(404).json({
        success: false,
        message: "Өтінім табылмады немесе бұрын өңделген"
      });
    }

    return res.status(200).json({
      success: true,
      message: status === "approved"
        ? "Жүргізуші мақұлданды"
        : "Өтінім қабылданбады",
      application: updated[0]
    });

  } catch (error) {
    console.error("Admin update error:", error);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі"
    });
  }
}
