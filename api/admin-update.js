
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

  const expected = crypto
    .createHmac("sha256", password)
    .update("urzhar-admin:" + expires)
    .digest("hex");

  const received = Buffer.from(parts[1], "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (received.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(received, expectedBuffer);
}

async function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const derivedKey = await scrypt(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1
  });

  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
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
    const adminPassword = process.env.ADMIN_PASSWORD;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!adminPassword || !supabaseUrl || !serviceKey) {
      return res.status(500).json({
        success: false,
        message: "Сервер баптаулары толық емес"
      });
    }

    if (!verifyAdmin(req, adminPassword)) {
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

    const cleanUrl = supabaseUrl.replace(/\/$/, "");

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    };

    // Жүргізушіні мақұлдау және аккаунтын жасау
    if (status === "approved") {
      const temporaryPassword = crypto
        .randomBytes(9)
        .toString("base64url");

      const passwordHash = await createPasswordHash(temporaryPassword);

      const response = await fetch(
        `${cleanUrl}/rest/v1/rpc/approve_driver_application`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            p_application_id: id,
            p_password_hash: passwordHash
          })
        }
      );

      if (!response.ok) {
        console.error("Driver approval error:", await response.text());

        return res.status(502).json({
          success: false,
          message: "Жүргізушіні мақұлдау немесе аккаунт жасау мүмкін болмады"
        });
      }

      const result = await response.json();

      if (!result || !result.success || !result.driver_id) {
        return res.status(502).json({
          success: false,
          message: "Аккаунт жасау нәтижесі дұрыс емес"
        });
      }

      return res.status(200).json({
        success: true,
        message: "Жүргізуші мақұлданды. Аккаунт жасалды.",
        temporary_password: temporaryPassword,
        driver_id: result.driver_id
      });
    }

    // Өтінімді қабылдамау
    const response = await fetch(
      `${cleanUrl}/rest/v1/driver_applications?id=eq.${id}&status=eq.pending`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          status: "rejected"
        })
      }
    );

    if (!response.ok) {
      console.error("Driver rejection error:", await response.text());

      return res.status(502).json({
        success: false,
        message: "Өтінімді қабылдамау мүмкін болмады"
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
      message: "Өтінім қабылданбады"
    });

  } catch (error) {
    console.error("Admin update error:", error);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі"
    });
  }
}
