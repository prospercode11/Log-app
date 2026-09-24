/* Who may call the Element 26 functions. A browser always sends Origin on a cross-origin
   request, so a request with no Origin, or one from anywhere else, is a script or a copy
   of the app hosted somewhere else, and it is refused.

   Exact origins: scheme + host (+ port), no path, no trailing slash. */
export const ALLOWED_ORIGINS: string[] = [
  "https://element26.vercel.app",
  "https://log-app-prosper-8997s-projects.vercel.app",
  "https://prospercode11.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

/* Vercel preview deployments get a fresh hostname per push, all ending in the team slug. */
const ALLOWED_PATTERNS: RegExp[] = [
  /^https:\/\/[a-z0-9-]+-prosper-8997s-projects\.vercel\.app$/,
];

export function originAllowed(origin: string): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin) || ALLOWED_PATTERNS.some((re) => re.test(origin));
}

/* The caller's address, for rate limits. Supabase's edge puts the client first. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
}
