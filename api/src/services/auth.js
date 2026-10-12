import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import { prisma } from "../prisma.js";

/** Access JWT lifetime (refresh still 30d). */
const ACCESS_TOKEN_EXPIRES_IN = "7d";
const REFRESH_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000;

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
}

export function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * @param {string} email
 * @param {string} otp
 */
export async function sendOTP(email, otp) {
  if (process.env.NODE_ENV === "development") {
    console.log(`[OTP] Email: ${email} | Code: ${otp}`);
    return { success: true };
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: "DIRA <onboarding@resend.dev>",
      to: email,
      subject: "Your DIRA code",
      html: `
        <div style="background:#0E0E0F;padding:40px;
                    font-family:Georgia,serif;">
          <p style="color:#F5F3EE;font-size:16px;
                    margin-bottom:24px;">
            Your DIRA sign-in code:
          </p>
          <p style="color:#F5F3EE;font-size:48px;
                    letter-spacing:12px;font-weight:bold;
                    margin:0;">
            ${otp}
          </p>
          <p style="color:#6B6963;font-size:13px;
                    margin-top:24px;">
            Expires in 10 minutes.
          </p>
        </div>
      `,
    });

    if (error) {
      console.error("[OTP] Email failed:", error);
      console.log(`[OTP] FALLBACK Email: ${email} | Code: ${otp}`);
    }
  } catch (err) {
    console.error("[OTP] Email failed:", err);
    console.log(`[OTP] FALLBACK Email: ${email} | Code: ${otp}`);
  }

  return { success: true };
}

/**
 * @param {{ id: string; otpCode: string | null; otpExpiresAt: Date | null; otpAttempts: number }} user
 * @param {string} otp
 */
export async function verifyOTP(user, otp) {
  if (user.otpAttempts >= 5) {
    return { valid: false, reason: "locked" };
  }
  if (!user.otpCode || !user.otpExpiresAt) {
    return { valid: false, reason: "invalid" };
  }
  if (user.otpExpiresAt.getTime() <= Date.now()) {
    return { valid: false, reason: "expired" };
  }
  if (user.otpCode !== otp) {
    await prisma.user.update({
      where: { id: user.id },
      data: { otpAttempts: { increment: 1 } },
    });
    return { valid: false, reason: "invalid" };
  }
  return { valid: true };
}

/**
 * @param {string} userId
 */
export async function generateTokens(userId) {
  const secret = getJwtSecret();
  const accessToken = jwt.sign(
    { userId, type: "access" },
    secret,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN },
  );
  const refreshToken = crypto.randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);
  await prisma.refreshToken.create({
    data: { userId, token: refreshToken, expiresAt },
  });
  return { accessToken, refreshToken };
}

/**
 * @param {string} refreshToken
 */
export async function refreshAccessToken(refreshToken) {
  const row = await prisma.refreshToken.findFirst({
    where: {
      token: refreshToken,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!row) {
    throw new Error("invalid refresh token");
  }
  const secret = getJwtSecret();
  const accessToken = jwt.sign(
    { userId: row.userId, type: "access" },
    secret,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN },
  );
  return { accessToken };
}

/**
 * @param {string} refreshToken
 */
export async function revokeRefreshToken(refreshToken) {
  await prisma.refreshToken.updateMany({
    where: { token: refreshToken, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { success: true };
}
