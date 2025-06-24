const crypto = require("crypto");

const SECRET_KEY = "my_super_secret_key_123"; // 32 ký tự (256-bit)
const IV = crypto.randomBytes(16); // Vector khởi tạo (đổi mỗi lần nếu muốn)

function encrypt(data, key = SECRET_KEY) {
  const json = typeof data === "string" ? data : JSON.stringify(data);

  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key, 'utf-8'), IV);
  let encrypted = cipher.update(json, "utf8", "base64");
  encrypted += cipher.final("base64");

  // Ghép IV + dữ liệu để decode được
  return IV.toString("base64") + ":" + encrypted;
}

function decrypt(encodedString, key = SECRET_KEY) {
  const [ivBase64, encrypted] = encodedString.split(":");
  const iv = Buffer.from(ivBase64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key, 'utf-8'), iv);
  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");

  // Trả về JSON nếu decode được
  try {
    return JSON.parse(decrypted);
  } catch (e) {
    return decrypted;
  }
}
