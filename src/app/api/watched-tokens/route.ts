import { NextResponse } from "next/server";
import { Pool } from "pg";

export const dynamic = "force-dynamic";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET() {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM "WatchedToken" WHERE "isActive" = true ORDER BY symbol'
    );
    return NextResponse.json(rows);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { symbol, mint, decimals, strategies } = await req.json();
    const { rows } = await pool.query(
      `INSERT INTO "WatchedToken" (id, symbol, mint, decimals, "isActive", strategies, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, true, $4, NOW(), NOW())
       ON CONFLICT (symbol) DO UPDATE SET "isActive" = true, "updatedAt" = NOW()
       RETURNING *`,
      [symbol, mint, decimals || 6, strategies || "all"]
    );
    return NextResponse.json(rows[0], { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const { symbol, isActive, strategies } = await req.json();
    const { rows } = await pool.query(
      `UPDATE "WatchedToken" SET "isActive" = COALESCE($2, "isActive"), strategies = COALESCE($3, strategies), "updatedAt" = NOW()
       WHERE symbol = $1 RETURNING *`,
      [symbol, isActive, strategies]
    );
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(rows[0]);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
