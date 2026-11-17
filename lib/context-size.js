/**
 * Pre-flight context measurement.
 *
 * A handoff copies the session's *body*, and a body that already exceeds the
 * model window cannot be copied into a working session: the provider stops the
 * very next request at the egress fuse ("the body ITSELF exceeds the window")
 * after the upload has already been spent. The plugin's job is therefore to
 * refuse that copy in milliseconds, with numbers the user can act on, instead
 * of producing a session that dies on its first turn.
 *
 * The estimate is deliberately conservative and provider-agnostic: CJK
 * characters count as one token, everything else as roughly a third, and an
 * image counts as its vision budget (pixels / 750). It is a yardstick for
 * "this session is already too heavy to clone", not an exact bill.
 */

/** The guard never assumes a window below one million tokens (#4079). */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/** Above this share of the window a verbatim copy is refused. */
export const REFUSE_RATIO = 0.8;

/** Above this share we copy, but say so in the result. */
export const WARN_RATIO = 0.5;

const VISION_PIXELS_PER_TOKEN = 750;
const FALLBACK_IMAGE_TOKENS = 1_600;
const LATIN_TOKENS_PER_CHAR = 0.3;

/** Window advertised by the session's request context, else the guard floor. */
export function readContextWindow(session) {
  const context = session?.requestContext?.() ?? {};
  const window = Number(context?.contextWindow);
  return Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
}

const isImage = (block) =>
  block?.type === "image" || block?.type === "image-url" || block?.type === "image-ref";

const imageTokens = (block) => {
  const attachment = block?.attachment ?? block;
  const width = Number(attachment?.width);
  const height = Number(attachment?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return FALLBACK_IMAGE_TOKENS;
  }
  return Math.ceil((width * height) / VISION_PIXELS_PER_TOKEN);
};

/**
 * Measure a message snapshot.
 * @returns {{textTokens: number, imageTokens: number, images: number, approxTokens: number}}
 */
export function measureContext(messages) {
  let cjk = 0;
  let latin = 0;
  let images = 0;
  let pixels = 0;

  const addText = (text) => {
    for (const char of text) {
      if (char.codePointAt(0) >= 0x2e80) cjk += 1;
      else latin += 1;
    }
  };

  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (isImage(node)) {
      images += 1;
      pixels += imageTokens(node);
      return;
    }
    if (node.type === "text" && typeof node.text === "string") {
      addText(node.text);
      return;
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") walk(value);
    }
  };

  walk(messages);
  const textTokens = cjk + Math.ceil(latin * LATIN_TOKENS_PER_CHAR);
  return { textTokens, imageTokens: pixels, images, approxTokens: textTokens + pixels };
}

const formatNumber = (value) => Math.round(value).toLocaleString("en-US");

/** `约 2.8M tokens（文字 1.3M · 977 张图 1.5M；窗口 1,000,000）` */
export function describeMeasure(measure, window) {
  const parts = [`文字约 ${formatNumber(measure.textTokens)}`];
  if (measure.images > 0) {
    parts.push(`图片 ${measure.images} 张约 ${formatNumber(measure.imageTokens)}`);
  }
  return `约 ${formatNumber(measure.approxTokens)} tokens（${parts.join(" · ")}；窗口 ${formatNumber(window)}）`;
}

/** Share of the window this snapshot occupies, clamped to a sane range. */
export function contextRatio(measure, window) {
  if (!Number.isFinite(window) || window <= 0) return 0;
  return measure.approxTokens / window;
}

export const percent = (ratio) => `${Math.round(ratio * 100)}%`;
