import { SignJWT, jwtVerify } from "jose";
import "./mongodb.ts";

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error("JWT_SECRET must be set.");
}

const secret = new TextEncoder().encode(jwtSecret);
const issuer = "fixmate-server";
const audience = "fixmate-api";

export function createAccessToken(userId: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

export async function verifyAccessToken(token: string) {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ["HS256"],
    issuer,
    audience,
  });
  return payload.sub;
}
