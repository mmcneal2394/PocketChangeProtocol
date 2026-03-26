import { NextResponse } from "next/server";
import { Pool } from "pg";

export const dynamic = "force-dynamic";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET() {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM "TelegramChat" WHERE "isActive" = true'
    );
    return NextResponse.json(rows.map((c: any) => ({ ...c, chatId: c.chatId.toString() })));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { chatId, chatType, title } = await req.json();
    const { rows } = await pool.query(
      `INSERT INTO "TelegramChat" (id, "chatId", "chatType", title, "isActive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, true, NOW(), NOW())
       ON CONFLICT ("chatId") DO UPDATE SET "isActive" = true, "updatedAt" = NOW()
       RETURNING *`,
      [chatId, chatType || "group", title || null]
    );
    return NextResponse.json({ ...rows[0], chatId: rows[0].chatId.toString() }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const { chatId, isActive } = await req.json();
    const { rows } = await pool.query(
      `UPDATE "TelegramChat" SET "isActive" = $2, "updatedAt" = NOW() WHERE "chatId" = $1 RETURNING *`,
      [chatId, isActive ?? false]
    );
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ...rows[0], chatId: rows[0].chatId.toString() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
