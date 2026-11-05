
function verifyAdmin(req, password) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)urzhar_admin_session=([^;]+)/);

  if (!match) return false;

  const parts = match[1].split(".");
  if (parts.length !== 2) return false;

  const expires = Number(parts[0]);
  const receivedSignature = parts[1];

  if (!Number.isFinite(expires) || expires <= Date.now()) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", password)
    .update("urzhar-admin:" + expires)
    .digest("hex");

  const received = Buffer.from(receivedSignature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");

  if (received.length !== expected.length) return false;

  return crypto.timingSafeEqual(received, expected);
}
