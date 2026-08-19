import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyToken } from '@/lib/auth';
import { resolveSafePath } from '@/lib/fs-security';
import { UPLOAD_DIR } from '@/lib/server-config';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file

function sanitizeFileName(name: string): string {
  // \w без флага u — это [A-Za-z0-9_], поэтому кириллица целиком уезжала в подчёркивания:
  // «Снимок экрана 2026-08-19 113626.png» → «______ ______ 2026-08-19 113626.png».
  // Имя переставало что-либо значить, файл искался только по содержимому — на этом
  // 29.07 потеряли полтора часа (LDG dt-20260729-001). Теперь режем ровно опасное:
  //   · разделители пути и управляющие символы,
  //   · windows-запрещённые < > : " | ? *,
  //   · ведущие точки (скрытые файлы и обход вверх).
  // Буквы любого алфавита остаются. Вторая линия защиты — resolveSafePath ниже.
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/\p{C}/gu, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return (cleaned || 'file.bin').slice(0, 200);
}

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get('wc-token')?.value;
    if (!token || !verifyToken(token)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const form = await req.formData();
    const targetDirRaw = (form.get('targetDir') as string) || UPLOAD_DIR;
    const targetDir = resolveSafePath(targetDirRaw);
    await fs.mkdir(targetDir, { recursive: true });

    const entries = form.getAll('files');
    if (!entries.length) return NextResponse.json({ ok: false, error: 'No files' }, { status: 400 });

    const saved: { name: string; path: string; size: number }[] = [];

    for (const item of entries) {
      if (!(item instanceof File)) continue;
      if (item.size > MAX_FILE_SIZE) {
        return NextResponse.json({ ok: false, error: `File ${item.name} exceeds 50MB limit` }, { status: 413 });
      }
      const safeName = sanitizeFileName(item.name || 'file.bin');
      const fullPath = resolveSafePath(path.join(targetDir, safeName));
      const bytes = Buffer.from(await item.arrayBuffer());
      await fs.writeFile(fullPath, bytes);
      saved.push({ name: safeName, path: fullPath, size: bytes.length });
    }

    return NextResponse.json({ ok: true, files: saved });
  } catch {
    return NextResponse.json({ ok: false, error: 'Upload failed' }, { status: 500 });
  }
}
