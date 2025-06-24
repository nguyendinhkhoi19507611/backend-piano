// routes/auth.js
const express = require("express");
const router = express.Router();
const {
  getLoginURL,
  getAccessTokenFromCode,
  refreshAccessToken,
  getStoredToken,
} = require("../services/spotifyServices");

// GET /auth/login → redirect đến Spotify
router.get("/login", (req, res) => {
  res.redirect(getLoginURL());
});

// GET /auth/callback → Spotify redirect về
router.get("/callback", async (req, res) => {
  const code = req.query.code;

  try {
    const tokens = await getAccessTokenFromCode(code);

    res.send(`
      <h2>✅ Lấy token thành công!</h2>
      <p><b>Access Token:</b></p>
      <code>${tokens.access_token}</code>
      <p><b>Refresh Token:</b></p>
      <code>${tokens.refresh_token}</code>
    `);
  } catch (err) {
    console.error("❌ Lỗi callback:", err.response?.data || err.message);
    res.status(500).send("Lỗi khi lấy token từ Spotify.");
  }
});

// GET /auth/refresh → làm mới token
router.get("/refresh", async (req, res) => {
  try {
    const newToken = await refreshAccessToken();
    res.send({ access_token: newToken });
  } catch (err) {
    res.status(500).send("Lỗi khi làm mới token.");
  }
});

// GET /auth/token → lấy token hiện tại
router.get("/token", (req, res) => {
  const token = getStoredToken();
  res.send({ access_token: token });
});

module.exports = router;
