import { NextResponse } from "next/server";

// In-memory store until Prisma client is wired up with PostgreSQL
let chats: any[] = [];

// GET: list active chats
export async function GET() {
  const active = chats.filter(c => c.isActive);
  return NextResponse.json(active);
}

// POST: upsert a chat (subscribe)
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { chatId, chatType, title } = body;

    const existing = chats.find(c => c.chatId === chatId);
    if (existing) {
      existing.isActive = true;
      existing.title = title || existing.title;
      existing.updatedAt = new Date().toISOString();
      return NextResponse.json(existing);
    }

    const chat = {
      id: crypto.randomUUID(),
      chatId,
      chatType: chatType || "group",
      title: title || null,
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    chats.push(chat);
    return NextResponse.json(chat, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

// PATCH: deactivate a chat (unsubscribe)
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { chatId, isActive } = body;

    const chat = chats.find(c => c.chatId === chatId);
    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    chat.isActive = isActive ?? false;
    chat.updatedAt = new Date().toISOString();
    return NextResponse.json(chat);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
