import { NextRequest, NextResponse } from "next/server";

export function GET(request: NextRequest) {
  const next = request.nextUrl.searchParams.get("next") ?? "/";
  const loginUrl = new URL(`/login?redirect=${encodeURIComponent(next)}`, request.url);
  return NextResponse.redirect(loginUrl);
}
