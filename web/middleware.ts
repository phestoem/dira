import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const accessToken = request.cookies.get("dira_access_token")?.value;
  const { pathname } = request.nextUrl;

  if (pathname === "/login") {
    if (accessToken) {
      return NextResponse.redirect(new URL("/intake", request.url));
    }
    return NextResponse.next();
  }

  if (
    !accessToken &&
    (pathname === "/intake" ||
      pathname === "/events" ||
      pathname.startsWith("/events/") ||
      pathname === "/journal" ||
      pathname === "/account")
  ) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/intake", "/login", "/events", "/events/:path*", "/journal", "/account"],
};
