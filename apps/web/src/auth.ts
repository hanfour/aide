import NextAuth, { type NextAuthResult } from "next-auth";
import { createDb } from "@aide/db";
import { buildAuthConfig } from "@aide/auth";
import { env } from "./env.js";

const { db } = createDb(env.DATABASE_URL);

const result: NextAuthResult = NextAuth(
  buildAuthConfig(db, {
    AUTH_SECRET: env.AUTH_SECRET,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
    superAdminEmail: env.BOOTSTRAP_SUPER_ADMIN_EMAIL,
    defaultOrgSlug: env.BOOTSTRAP_DEFAULT_ORG_SLUG,
    defaultOrgName: env.BOOTSTRAP_DEFAULT_ORG_NAME,
  }),
);

export const handlers: NextAuthResult["handlers"] = result.handlers;
export const auth: NextAuthResult["auth"] = result.auth;
export const signIn: NextAuthResult["signIn"] = result.signIn;
export const signOut: NextAuthResult["signOut"] = result.signOut;

export const { GET, POST } = handlers;
