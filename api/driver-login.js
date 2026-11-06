
import crypto from "crypto";
import { promisify } from "util";

const scrypt = promisify(crypto.scrypt);

const COOKIE_NAME = "urzhar_driver_session";
const SESSION_DAYS = 7;

function createSession(driverId, secret) {
  const expires = Date.now() + SESSION_DAYS * 86400000;

  const signature = crypto
    .createHmac("sha256", secret)
    .update(`urzhar-driver:${driverId}:${expires}`)
    .digest("hex");

  return `${driverId}.${expires}.${signature}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string") return false;

  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const [_, salt, hash] = parts;
  const storedKey = Buffer.from(hash, "hex");

  if (storedKey.length !== 64) return false;

  const derivedKey = await scrypt(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1
  });

  return crypto.timingSafeEqual(derivedKey, storedKey);
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
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        success: false,
        message: "Сервер баптаулары толық емес"
      });
    }

    const { phone, password } = req.body || {};

    if (
      typeof phone !== "string" ||
      typeof password !== "string" ||
      !phone.trim() ||
      !password ||
      password.length > 200
    ) {
      return res.status(400).json({
        success: false,
        message: "Телефон мен құпиясөзді енгізіңіз"
      });
    }

    const cleanUrl = supabaseUrl.replace(/\/$/, "");
    const cleanPhone = phone.trim();

    const response = await fetch(
      `${cleanUrl}/rest/v1/drivers?phone=eq.${encodeURIComponent(cleanPhone)}&select=id,full_name,phone,password_hash&limit=1`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      console.error("Driver login DB error:", response.status);

      return res.status(502).json({
        success: false,
        message: "Дерекқормен байланыс қатесі"
      });
    }

    const drivers = await response.json();
    const driver = drivers[0];

    if (!driver || !driver.password_hash) {
      return res.status(401).json({
        success: false,
        message: "Телефон немесе құпиясөз қате"
      });
    }

    const valid = await verifyPassword(
      password,
      driver.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        success: false,
        message: "Телефон немесе құпиясөз қате"
      });
    }

    const token = createSession(driver.id, serviceKey);

    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`
    );

    return res.status(200).json({
      success: true,
      message: "Жүйеге сәтті кірдіңіз",
      driver: {
        id: driver.id,
        full_name: driver.full_name,
        phone: driver.phone
      }
    });

  } catch (error) {
    console.error("Driver login error:", error);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі"
    });
  }
}
