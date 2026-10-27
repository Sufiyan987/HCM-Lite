import { randomInt, randomUUID } from "node:crypto";

const imageActionPattern = /\b(?:create|generate|make|draw|design|edit|enhance|modify|change|transform|retouch|upscale|reimagine|remove|replace|add)\b/i;
const imageNounPattern = /\b(?:image|img|picture|photo|photograph|illustration|artwork|logo|icon|wallpaper|banner|poster)\b/i;
const supportedEditTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxGeneratedImageBytes = 12 * 1024 * 1024;
const comfyUrl = () => (process.env.COMFYUI_URL?.trim() || "http://127.0.0.1:8188").replace(/\/+$/, "");

export function isImageGenerationRequest(question, attachments = []) {
  if (!imageActionPattern.test(question)) return false;
  return imageNounPattern.test(question) || attachments.some((file) => file.mimeType.startsWith("image/"));
}

export function isNewImageRequest(question) {
  return /\b(?:create|generate|draw|design)\b/i.test(question)
    || /\bmake\s+(?:a|an|me)\s+(?:new\s+)?(?:image|img|picture|photo)\b/i.test(question);
}

async function comfyRequest(path, options = {}) {
  const { timeout = 15_000, ...requestOptions } = options;
  let response;
  try {
    response = await fetch(`${comfyUrl()}${path}`, {
      ...requestOptions,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "Local ComfyUI took too long to respond. Check that it is running and try again."
      : "Local ComfyUI is not responding. Install/start ComfyUI on this PC, then try again.";
    throw Object.assign(new Error(message), { status: 503, cause: error });
  }
  return response;
}

async function readJson(response, action) {
  try {
    return await response.json();
  } catch (error) {
    throw Object.assign(new Error(`ComfyUI returned an invalid response while ${action}.`), { status: 502, cause: error });
  }
}

function imageErrorMessage(error) {
  if (typeof error === "string") return error;
  if (Array.isArray(error)) return error.map(imageErrorMessage).join(" ");
  if (error && typeof error === "object") {
    return [error.message, error.details].filter((value) => typeof value === "string").join(": ");
  }
  return "";
}

async function findCheckpoint() {
  const response = await comfyRequest("/object_info/CheckpointLoaderSimple");
  if (!response.ok) throw Object.assign(new Error("Could not read available image models from ComfyUI."), { status: 502 });
  const info = await readJson(response, "checking image models");
  const checkpoints = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    throw Object.assign(new Error("ComfyUI is running, but no checkpoint model is installed. Download a compatible image model into ComfyUI's models/checkpoints folder and restart ComfyUI."), { status: 503 });
  }
  const configured = process.env.COMFYUI_CHECKPOINT?.trim();
  if (configured && !checkpoints.includes(configured)) {
    throw Object.assign(new Error(`ComfyUI cannot find the configured model "${configured}". Check COMFYUI_CHECKPOINT in .env.`), { status: 503 });
  }
  return configured || checkpoints[0];
}

async function uploadSourceImage(image) {
  if (!supportedEditTypes.has(image.mimeType)) {
    throw Object.assign(new Error("Local image editing accepts PNG, JPEG, or WebP files. Please convert this image and try again."), { status: 400 });
  }
  const form = new FormData();
  form.set("image", new Blob([image.content], { type: image.mimeType }), image.name);
  form.set("type", "input");
  form.set("overwrite", "false");
  const response = await comfyRequest("/upload/image", { method: "POST", body: form });
  const result = await readJson(response, "uploading the image");
  if (!response.ok || !result.name) {
    const reason = imageErrorMessage(result.error || result);
    throw Object.assign(new Error(reason || "ComfyUI could not accept the uploaded image."), { status: 502 });
  }
  return result;
}

function createWorkflow({ prompt, checkpoint, uploadedImage }) {
  const workflow = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality, distorted, watermark, text artifacts", clip: ["1", 1] } },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: randomInt(0, 2 ** 48 - 1),
        steps: 20,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: uploadedImage ? 0.62 : 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: uploadedImage ? ["4", 0] : ["6", 0],
      },
    },
    "7": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "8": { class_type: "SaveImage", inputs: { filename_prefix: "hcm", images: ["7", 0] } },
  };
  if (uploadedImage) {
    workflow["4"] = { class_type: "LoadImage", inputs: { image: uploadedImage.name } };
    workflow["6"] = { class_type: "VAEEncode", inputs: { pixels: ["4", 0], vae: ["1", 2] } };
  } else {
    workflow["6"] = { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } };
  }
  return workflow;
}

export async function generateLocalImage({ prompt, image }) {
  const editing = Boolean(image);
  const checkpoint = await findCheckpoint();
  const uploadedImage = editing ? await uploadSourceImage(image) : null;
  const response = await comfyRequest("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: createWorkflow({ prompt, checkpoint, uploadedImage }), client_id: randomUUID() }),
  });
  const result = await readJson(response, "starting image generation");
  if (!response.ok || !result.prompt_id) {
    const details = imageErrorMessage(result.error || result.node_errors);
    throw Object.assign(new Error(details || "ComfyUI could not start the image workflow. Check that the selected model supports this workflow."), { status: 502 });
  }

  const deadline = Date.now() + 5 * 60 * 1000;
  let outputs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const historyResponse = await comfyRequest(`/history/${encodeURIComponent(result.prompt_id)}`);
    if (!historyResponse.ok) continue;
    const history = await readJson(historyResponse, "checking image generation");
    const execution = history[result.prompt_id];
    if (!execution) continue;
    if (execution.status?.status_str === "error") {
      const details = imageErrorMessage(execution.status.messages);
      throw Object.assign(new Error(details || "ComfyUI could not finish this image workflow. Check its console for the model error."), { status: 502 });
    }
    if (execution.outputs) {
      outputs = Object.values(execution.outputs).flatMap((node) => node.images || []);
      if (outputs.length) break;
    }
  }
  if (!outputs?.length) {
    throw Object.assign(new Error("Local image generation timed out after five minutes. This PC may need a supported GPU or a smaller model."), { status: 504 });
  }

  const images = [];
  for (const [index, output] of outputs.slice(0, 3).entries()) {
    const query = new URLSearchParams({
      filename: output.filename,
      subfolder: output.subfolder || "",
      type: output.type || "output",
    });
    const imageResponse = await comfyRequest(`/view?${query}`, { timeout: 30_000 });
    if (!imageResponse.ok) {
      throw Object.assign(new Error("ComfyUI created an image but the app could not download it. Check ComfyUI's output folder."), { status: 502 });
    }
    const content = Buffer.from(await imageResponse.arrayBuffer());
    if (!content.length || content.length > maxGeneratedImageBytes) {
      throw Object.assign(new Error("ComfyUI returned an empty or oversized image."), { status: 502 });
    }
    const extension = output.filename.split(".").pop()?.toLowerCase();
    const mimeType = extension === "webp" ? "image/webp" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "image/png";
    images.push({
      name: `comfyui-${editing ? "edited" : "generated"}-${Date.now()}-${index + 1}.${extension || "png"}`,
      mimeType,
      content,
    });
  }
  return { images, model: checkpoint };
}
