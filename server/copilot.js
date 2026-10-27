import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";

const getEncryptionKey = () => {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error("Set a stable JWT_SECRET before connecting a Copilot account.");
  return createHash("sha256").update("hcm-lite-copilot-token-v1\0").update(secret).digest();
};

export function encryptCopilotAccessToken(accessToken) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(accessToken, "utf8"), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url"),
  });
}

export function decryptCopilotAccessToken(value) {
  const record = JSON.parse(value);
  if (!record.iv || !record.tag || !record.data) throw new Error("The saved Copilot connection is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(record.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function getCopilotErrorMessage(error) {
  const providerMessage = String(error?.message || error?.stderr || error?.code || "");
  const normalized = providerMessage.toLowerCase();
  if (/monthly quota|quota exceeded|exceeded.*quota|usage limit|rate limit|too many requests/.test(normalized)) {
    return "GitHub Copilot ka usage quota/limit khatam ho gaya hai. GitHub Copilot plan aur usage check karein; limit reset hone ya usage available hone ke baad dobara try karein.";
  }
  if (/unauthorized|authentication|invalid token|bad credentials|http 401/.test(normalized)) {
    return "GitHub Copilot ne saved connection accept nahi ki. Settings mein Copilot disconnect karke sahi GitHub account se dobara connect karein.";
  }
  if (/forbidden|http 403|not entitled|not authorized/.test(normalized)) {
    return "Is GitHub account ko Copilot chat access nahi mila. GitHub Copilot subscription, organization policy, aur account access check karein.";
  }
  if (/timed out|timeout|econnreset|enotfound|network|fetch failed/.test(normalized)) {
    return "GitHub Copilot tak network connection nahi ho saka. Internet/proxy check karke phir try karein.";
  }
  return "GitHub Copilot se jawab nahi mila. Copilot access aur connection check karein, phir dobara try karein.";
}

const copilotDirectory = join(process.env.COPILOT_DATA_DIR || join(process.cwd(), "data"), "copilot-runtime");

export const copilotClient = new CopilotClient({
  mode: "empty",
  baseDirectory: copilotDirectory,
  useLoggedInUser: false,
  logLevel: "error",
});

let clientStart;

export async function askCopilot(accessToken, prompt, instructions, files = []) {
  if (!clientStart) {
    clientStart = copilotClient.start().catch((error) => {
      clientStart = undefined;
      throw error;
    });
  }
  await clientStart;

  const session = await copilotClient.createSession({
    gitHubToken: accessToken,
    availableTools: [],
    imageGeneration: { enabled: true, watermark: true, saveToDisk: false },
    systemMessage: { mode: "append", content: instructions },
  });
  let attachmentDirectory;
  const generatedImages = [];
  const unsubscribeGeneratedImages = session.on("tool.execution_complete", (event) => {
    const result = event.data.result;
    const blocks = [
      ...(result?.contents || []),
      ...(result?.binaryResultsForLlm || []),
    ];
    for (const block of blocks) {
      if (block.type !== "image" || !block.data
        || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType)
        || generatedImages.length >= 3) continue;
      const content = Buffer.from(block.data, "base64");
      if (!content.length || content.length > 12 * 1024 * 1024
        || content.toString("base64") !== block.data) continue;
      if (generatedImages.some((image) => image.content.equals(content))) continue;
      const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[block.mimeType];
      generatedImages.push({
        name: `copilot-image-${generatedImages.length + 1}.${extension}`,
        mimeType: block.mimeType,
        content,
      });
    }
  });
  try {
    const attachments = [];
    if (files.length) {
      attachmentDirectory = await mkdtemp(join(tmpdir(), "hcm-copilot-"));
      for (const [index, file] of files.entries()) {
        const extension = extname(file.name).slice(0, 12);
        const path = join(attachmentDirectory, `${index}${extension}`);
        await writeFile(path, file.content, { flag: "wx" });
        attachments.push({ type: "file", path, displayName: file.name });
      }
    }
    const response = await session.sendAndWait({ prompt, ...(attachments.length ? { attachments } : {}) }, 60_000);
    const answer = response?.data.content?.trim();
    if (!answer && !generatedImages.length) throw new Error("Copilot returned an empty answer.");
    return {
      answer: answer || "I created the image you requested.",
      images: generatedImages,
    };
  } finally {
    try {
      unsubscribeGeneratedImages();
      await session.disconnect();
    } finally {
      if (attachmentDirectory) await rm(attachmentDirectory, { recursive: true, force: true });
    }
  }
}

export async function stopCopilotClient() {
  if (!clientStart) return;
  await clientStart;
  await copilotClient.stop();
  clientStart = undefined;
}
