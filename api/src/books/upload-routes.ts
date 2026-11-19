// Uploading a Book (PRD 4.3.2, F4): the checks that refuse a file before any Book exists, in the PRD's order
// (format, size, quota), and the upload rights declaration (PRD 4.1.2). The web client runs the same checks first
// from the upload policy, so a file it would refuse is not sent; these are the ones that hold.
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, count, eq } from "drizzle-orm";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import {
  BookSchema,
  ErrorSchema,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADED_BOOKS,
  UPLOAD_DECLARATION,
  UploadBookSchema,
  UploadPolicySchema,
} from "../contract.js";
import type { Db } from "../db/client.js";
import { auditLog, books, jobs, users } from "../db/schema.js";
import type { Tx } from "../jobs/lifecycle.js";
import { sourceKey } from "../storage.js";
import { validationHook } from "../validation.js";
import { addToShelf } from "./shelf.js";
import { NO_PROGRESS, toBook } from "./view.js";

// The PRD's messages (4.3.5 #1 to #3); web/src/shelf/uploadCheck.ts shows the same ones before sending a file.
const error = (code: string, message: string) => ({ error: { code, message } });
const unsupportedFormat = error("unsupported_format", "目前只支持 EPUB 格式");
const fileTooLarge = error("file_too_large", `文件不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`);
const uploadLimitReached = error(
  "upload_limit_reached",
  `内测期最多上传 ${MAX_UPLOADED_BOOKS} 本书，可删除不再听的书后再上传`,
);
const declarationRequired = error("declaration_required", "请先确认上传权利声明");

type Refusal = { refused: typeof uploadLimitReached; status: 409 } | { refused: typeof declarationRequired; status: 400 };

/** Room for the multipart framing around the file, so a file of exactly the limit still gets through. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

const uploadRoute = createRoute({
  method: "post",
  path: "/books",
  summary: "Upload an EPUB; creates a Book in parsing on the user's Shelf and queues a parse job",
  request: {
    body: { required: true, content: { "multipart/form-data": { schema: UploadBookSchema } } },
  },
  responses: {
    201: { description: "Book created", content: { "application/json": { schema: BookSchema } } },
    400: {
      description: "Not an EPUB, or the upload declaration is not confirmed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: { description: "The user holds the most uploaded Books allowed", content: { "application/json": { schema: ErrorSchema } } },
    413: { description: "The file is over the size limit", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const policyRoute = createRoute({
  method: "get",
  path: "/upload-policy",
  summary: "Limits an upload is checked against, and whether the user still has to confirm the declaration",
  responses: {
    200: { description: "Upload policy", content: { "application/json": { schema: UploadPolicySchema } } },
  },
});

/** Title before parsing: the file name without its extension (PRD 4.2.1). */
function titleFromFileName(name: string): string {
  return name.replace(/\.epub$/i, "").trim() || "Untitled";
}

/** Uploaded Books the user holds now: what the upload limit counts. Library Books on the Shelf do not count. */
export async function uploadedBooks(db: Db | Tx, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(books)
    .where(and(eq(books.ownerId, userId), eq(books.source, "upload")));
  return row!.n;
}

export function uploadRoutes({ db, storage, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  // Stops an oversized body while it streams in, before the form is parsed.
  app.post(
    "/books",
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES,
      onError: (c: Context) => c.json(fileTooLarge, 413),
    }),
  );

  /**
   * Refuses the upload when the user holds the most uploaded Books allowed, or has not confirmed the current
   * declaration and does not confirm it now. Null when it may go ahead.
   */
  async function refusal(tx: Db | Tx, user: typeof users.$inferSelect, declarationVersion: string | undefined) {
    if ((await uploadedBooks(tx, user.id)) >= MAX_UPLOADED_BOOKS) return { refused: uploadLimitReached, status: 409 } as const;
    if (user.uploadDeclarationVersion !== UPLOAD_DECLARATION.version && declarationVersion !== UPLOAD_DECLARATION.version) {
      return { refused: declarationRequired, status: 400 } as const;
    }
    return null;
  }

  app.openapi(uploadRoute, async (c) => {
    const { file, declarationVersion, voice } = c.req.valid("form");
    const userId = c.get("userId");
    if (!/\.epub$/i.test(file.name)) return c.json(unsupportedFormat, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json(fileTooLarge, 413);
    const [current] = await db.select().from(users).where(eq(users.id, userId));
    const early: Refusal | null = await refusal(db, current!, declarationVersion);
    if (early) return c.json(early.refused, early.status);

    const id = crypto.randomUUID();
    // Stored before the parse job is queued, so the job never points at a missing object; and outside the
    // transaction, so writing up to 50MB holds no lock. An upload refused below (a race) leaves its object behind.
    await storage.putObject(sourceKey(id), new Uint8Array(await file.arrayBuffer()), "application/epub+zip");

    const outcome = await db.transaction(async (tx) => {
      // Holding the user's row makes two uploads at once count one after the other, so neither passes the quota.
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      const refused: Refusal | null = await refusal(tx, user!, declarationVersion);
      if (refused) return refused;
      if (user!.uploadDeclarationVersion !== UPLOAD_DECLARATION.version) {
        await tx.update(users).set({ uploadDeclarationVersion: UPLOAD_DECLARATION.version }).where(eq(users.id, userId));
        await tx.insert(auditLog).values({
          actor: user!.email,
          action: "upload_declaration_accept",
          target: UPLOAD_DECLARATION.version,
          result: "ok",
        });
      }
      const [book] = await tx
        .insert(books)
        .values({ id, ownerId: userId, title: titleFromFileName(file.name), fileSize: file.size, voice })
        .returning();
      await tx.insert(jobs).values({ bookId: id, type: "parse" });
      await addToShelf(tx, userId, id, now());
      return { book: book! } as const;
    });
    if ("refused" in outcome) return c.json(outcome.refused, outcome.status);
    return c.json(toBook(outcome.book, undefined, NO_PROGRESS), 201);
  });

  app.openapi(policyRoute, async (c) => {
    const userId = c.get("userId");
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    return c.json(
      {
        maxFileBytes: MAX_UPLOAD_BYTES,
        maxBooks: MAX_UPLOADED_BOOKS,
        uploadedBooks: await uploadedBooks(db, userId),
        declaration: { ...UPLOAD_DECLARATION, accepted: user!.uploadDeclarationVersion === UPLOAD_DECLARATION.version },
      },
      200,
    );
  });

  return app;
}
