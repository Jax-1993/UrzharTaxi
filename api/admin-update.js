
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

function validUUID(id) {
  return typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
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

    const {
      id,
      status,
      action,
      driver_id
    } = req.body || {};

    const cleanUrl = supabaseUrl.replace(/\/$/, "");

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    };

    // =====================================
    // 1. ЖҮРГІЗУШІНІ БАСҚАРУ
    // =====================================

    if (["block_driver", "unblock_driver", "delete_driver"].includes(action)) {

      if (!validUUID(driver_id)) {
        return res.status(400).json({
          success: false,
          message: "Жүргізуші ID дұрыс емес"
        });
      }

      let updateData;
      let successMessage;

      if (action === "block_driver") {
        updateData = {
          is_blocked: true
        };

        successMessage = "Жүргізуші уақытша бұғатталды";
      }

      if (action === "unblock_driver") {
        updateData = {
          is_blocked: false
        };

        successMessage = "Жүргізуші аккаунты қайта ашылды";
      }

      if (action === "delete_driver") {
        updateData = {
          is_blocked: true,
          deleted_at: new Date().toISOString()
        };

        successMessage = "Жүргізуші аккаунты өшірілді";
      }

      const response = await fetch(
        `${cleanUrl}/rest/v1/drivers?id=eq.${encodeURIComponent(driver_id)}&deleted_at=is.null`,
        {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation"
          },
          body: JSON.stringify(updateData)
        }
      );

      const responseText = await response.text();

      if (!response.ok) {
        console.error("Driver management error:", responseText);

        return res.status(502).json({
          success: false,
          message: "Жүргізушіні басқару қатесі: " +
            responseText.slice(0, 500)
        });
      }

      let updated;

      try {
        updated = JSON.parse(responseText);
      } catch {
        return res.status(502).json({
          success: false,
          message: "Сервер жауабын оқу мүмкін болмады"
        });
      }

      if (!Array.isArray(updated) || updated.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Жүргізуші табылмады немесе бұрын өшірілген"
        });
      }

      return res.status(200).json({
        success: true,
        action,
        message: successMessage
      });
    }

    // =====================================
    // 2. ЖҮРГІЗУШІ ӨТІНІМІН ТЕКСЕРУ
    // =====================================

    if (!validUUID(id)) {
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

    // =====================================
    // 3. ӨТІНІМДІ МАҚҰЛДАУ
    // =====================================

    if (status === "approved") {
      const temporaryPassword = crypto
        .randomBytes(9)
        .toString("base64url");

      const passwordHash = await createPasswordHash(
        temporaryPassword
      );

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

      const responseText = await response.text();

      if (!response.ok) {
        console.error("Driver approval error:", responseText);

        return res.status(502).json({
          success: false,
          message: "Мақұлдау қатесі: " +
            responseText.slice(0, 700)
        });
      }

      let result;

      try {
        result = JSON.parse(responseText);
      } catch {
        return res.status(502).json({
          success: false,
          message: "Сервер нәтижесін оқу мүмкін болмады"
        });
      }

      if (!result || !result.success || !result.driver_id) {
        return res.status(502).json({
          success: false,
          message: "Аккаунт нәтижесі дұрыс емес"
        });
      }

      return res.status(200).json({
        success: true,
        message: "Жүргізуші мақұлданды. Аккаунт жасалды.",
        temporary_password: temporaryPassword,
        driver_id: result.driver_id
      });
    }

    // =====================================
    // 4. ӨТІНІМДІ ҚАБЫЛДАМАУ
    // =====================================

    const response = await fetch(
      `${cleanUrl}/rest/v1/driver_applications?id=eq.${encodeURIComponent(id)}&status=eq.pending`,
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
      const errorText = await response.text();

      return res.status(502).json({
        success: false,
        message: "Өтінімді қабылдамау қатесі: " +
          errorText.slice(0, 500)
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
