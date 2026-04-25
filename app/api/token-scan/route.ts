import { NextRequest } from "next/server";
import { proxyRequest } from "@/lib/backend-proxy";

export async function GET(req: NextRequest) {
  return proxyRequest(req, "/api/token-scan");
}
