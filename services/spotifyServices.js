// spotify.js
require("dotenv").config();
const axios = require("axios");

const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri = process.env.REDIRECT_URI;

let access_token = "";
let refresh_token = "";

/**
 * Tạo URL để người dùng đăng nhập Spotify
 */
function getLoginURL() {
  const scope = [
    "user-read-private",
    "user-read-email",
    "user-read-playback-state",
    "user-modify-playback-state",
    "streaming"
  ].join(" ");

  const authURL = `https://accounts.spotify.com/authorize?response_type=code&client_id=${client_id}&scope=${encodeURIComponent(
    scope
  )}&redirect_uri=${encodeURIComponent(redirect_uri)}`;

  return authURL;
}

/**
 * Đổi mã code lấy access_token
 */
async function getAccessTokenFromCode(code) {
  const result = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      code,
      redirect_uri,
      grant_type: "authorization_code",
    }),
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${client_id}:${client_secret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  access_token = result.data.access_token;
  refresh_token = result.data.refresh_token;

  return {
    access_token,
    refresh_token,
  };
}

/**
 * Làm mới access_token khi hết hạn
 */
async function refreshAccessToken() {
  if (!refresh_token) {
    throw new Error("Chưa có refresh_token");
  }

  const result = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
    }),
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${client_id}:${client_secret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  access_token = result.data.access_token;
  return access_token;
}

/**
 * Lấy token hiện tại (nếu có)
 */
function getStoredToken() {
  return access_token;
}

module.exports = {
  getLoginURL,
  getAccessTokenFromCode,
  refreshAccessToken,
  getStoredToken,
};
