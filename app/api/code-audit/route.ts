import { NextRequest } from "next/server";
import { proxyRequest } from "@/lib/backend-proxy";

export async function POST(req: NextRequest) {
  return proxyRequest(req, "/api/code-audit");
}
