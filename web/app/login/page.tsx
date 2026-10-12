"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestOTP, verifyOTP } from "@/lib/api";
import { saveTokens, saveUser } from "@/lib/auth";

type Step = "email" | "otp";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onEmailSubmit() {
    const value = email.trim();
    if (!value || loading) return;
    setError(null);
    setLoading(true);
    try {
      await requestOTP(value);
      setStep("otp");
      setOtp("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send code.");
    } finally {
      setLoading(false);
    }
  }

  async function submitOtp(code: string) {
    const value = email.trim();
    const digits = code.trim();
    if (!value || digits.length !== 6 || loading) return;
    setError(null);
    setLoading(true);
    try {
      const { accessToken, refreshToken, user } = await verifyOTP(value, digits);
      saveTokens({ accessToken, refreshToken });
      saveUser(user);
      router.push("/home");
    } catch (err) {
      setOtp("");
      setError(err instanceof Error ? err.message : "Invalid code.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6">
      {step === "email" ? (
        <div className="w-full max-w-sm text-center">
          <p className="mb-8 font-serif text-[17px] leading-relaxed text-[#F5F3EE]/90">
            What&apos;s your email?
          </p>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onEmailSubmit();
              }
            }}
            autoComplete="email"
            disabled={loading}
            placeholder="you@example.com"
            className="w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent pb-2 text-center text-[15px] text-[#F5F3EE] outline-none placeholder:text-[#6B6963]/70"
          />
          {error ? <p className="mt-6 text-sm text-red-300/85">{error}</p> : null}
          <button
            type="button"
            onClick={() => void onEmailSubmit()}
            disabled={loading || !email.trim()}
            className="mt-8 text-sm text-[#F5F3EE] underline-offset-4 hover:underline disabled:text-[#6B6963]"
          >
            {loading ? "Sending…" : "Continue"}
          </button>
        </div>
      ) : null}

      {step === "otp" ? (
        <div className="w-full max-w-sm text-center">
          <p className="mb-8 font-serif text-[17px] leading-relaxed text-[#F5F3EE]/90">
            Check your email. Enter the code.
          </p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={otp}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
              setOtp(digits);
              if (digits.length === 6) void submitOtp(digits);
            }}
            disabled={loading}
            placeholder="······"
            className="w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent pb-2 text-center font-mono text-2xl tracking-[0.35em] text-[#F5F3EE] outline-none placeholder:text-[#6B6963]/50"
          />
          {error ? <p className="mt-6 text-sm text-red-300/85">{error}</p> : null}
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setOtp("");
              setError(null);
            }}
            className="mt-8 text-sm text-[#6B6963] underline-offset-4 hover:underline"
          >
            Use a different email
          </button>
        </div>
      ) : null}
    </div>
  );
}
