import { prisma } from "../prisma.js";
import {
  generateOTP,
  sendOTP,
  verifyOTP,
  generateTokens,
  refreshAccessToken,
  revokeRefreshToken,
} from "../services/auth.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function emailLocalPart(email) {
  const n = normalizeEmail(email);
  const i = n.indexOf("@");
  return i > 0 ? n.slice(0, i) : n;
}

async function allocateHandle(email) {
  const base = emailLocalPart(email) || "user";
  let handle = base;
  let n = 1;
  while (await prisma.user.findUnique({ where: { handle } })) {
    n += 1;
    handle = `${base}-${n}`;
  }
  return handle;
}

export default async function authRoutes(fastify) {
  fastify.post("/auth/request-otp", async (request, reply) => {
    try {
      const { email: rawEmail } = request.body ?? {};
      if (!rawEmail || typeof rawEmail !== "string") {
        return reply.code(400).send({ error: "email is required" });
      }
      const email = normalizeEmail(rawEmail);
      if (!EMAIL_RE.test(email)) {
        return reply.code(400).send({ error: "invalid email" });
      }

      const otp = generateOTP();
      const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        await prisma.user.update({
          where: { id: existing.id },
          data: {
            otpCode: otp,
            otpExpiresAt,
            otpAttempts: 0,
          },
        });
      } else {
        const handle = await allocateHandle(email);
        await prisma.user.create({
          data: {
            email,
            handle,
            name: emailLocalPart(email) || handle,
            otpCode: otp,
            otpExpiresAt,
            otpAttempts: 0,
          },
        });
      }

      await sendOTP(email, otp);
      return {
        success: true,
        message: "Check your email for a code",
      };
    } catch (err) {
      fastify.log.error(err);
      return reply
        .code(500)
        .send({ error: err.message ?? "Failed to request code" });
    }
  });

  fastify.post("/auth/verify-otp", async (request, reply) => {
    try {
      const { email: rawEmail, otp } = request.body ?? {};
      if (!rawEmail || typeof rawEmail !== "string") {
        return reply.code(400).send({ error: "email is required" });
      }
      if (!otp || typeof otp !== "string") {
        return reply.code(400).send({ error: "otp is required" });
      }
      const email = normalizeEmail(rawEmail);
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply.code(404).send({ error: "not found" });
      }

      const result = await verifyOTP(user, otp.trim());
      if (!result.valid) {
        return reply.code(401).send({ error: result.reason });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          otpCode: null,
          otpExpiresAt: null,
          otpAttempts: 0,
          lastLoginAt: new Date(),
        },
      });

      const fresh = await prisma.user.findUnique({ where: { id: user.id } });
      if (!fresh) {
        return reply.code(404).send({ error: "not found" });
      }

      const { accessToken, refreshToken } = await generateTokens(fresh.id);

      return {
        accessToken,
        refreshToken,
        user: {
          id: fresh.id,
          handle: fresh.handle,
          name: fresh.name,
          email: fresh.email,
        },
      };
    } catch (err) {
      fastify.log.error(err);
      return reply
        .code(500)
        .send({ error: err.message ?? "Failed to verify code" });
    }
  });

  fastify.post("/auth/refresh", async (request, reply) => {
    try {
      const { refreshToken } = request.body ?? {};
      if (!refreshToken || typeof refreshToken !== "string") {
        return reply.code(400).send({ error: "refreshToken is required" });
      }
      const { accessToken } = await refreshAccessToken(refreshToken.trim());
      return { accessToken };
    } catch (err) {
      fastify.log.error(err);
      return reply
        .code(401)
        .send({ error: err.message ?? "invalid refresh token" });
    }
  });

  fastify.post("/auth/logout", async (request, reply) => {
    try {
      const { refreshToken } = request.body ?? {};
      if (!refreshToken || typeof refreshToken !== "string") {
        return reply.code(400).send({ error: "refreshToken is required" });
      }
      await revokeRefreshToken(refreshToken.trim());
      return { success: true };
    } catch (err) {
      fastify.log.error(err);
      return reply
        .code(500)
        .send({ error: err.message ?? "Failed to log out" });
    }
  });
}
