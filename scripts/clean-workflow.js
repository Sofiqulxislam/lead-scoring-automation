const fs = require("fs");

const [, , inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  console.error(
    "Usage: node clean-workflow.js <exported-file.json> <output-file.json>"
  );
  process.exit(1);
}

let wf;

try {
  wf = JSON.parse(fs.readFileSync(inputPath, "utf8"));
} catch (error) {
  console.error(`Could not read or parse "${inputPath}".`);
  console.error(error.message);
  process.exit(1);
}

const removed = new Set();
const replaced = new Set();
const warnings = [];

/* =========================================================
   1. Remove top-level n8n instance-specific information
   ========================================================= */

for (const key of [
  "id",
  "versionId",
  "meta",
  "staticData",
  "shared",
  "triggerCount",
]) {
  if (key in wf) {
    delete wf[key];
    removed.add(key);
  }
}

// Never publish pinned test/customer data
wf.pinData = {};
removed.add("pinData");

// Never publish an active workflow
wf.active = false;
replaced.add("active=false");

if (wf.settings && typeof wf.settings === "object") {
  for (const key of ["errorWorkflow", "timezone"]) {
    if (key in wf.settings) {
      delete wf.settings[key];
      removed.add(`settings.${key}`);
    }
  }
}

/* =========================================================
   2. Per-node cleanup
   ========================================================= */

if (!Array.isArray(wf.nodes)) {
  console.error("Invalid n8n workflow: 'nodes' array not found.");
  process.exit(1);
}

for (const node of wf.nodes) {
  if (!node || typeof node !== "object") continue;

  // Remove webhook IDs
  if ("webhookId" in node) {
    delete node.webhookId;
    removed.add("webhookId");
  }

  // Remove ALL n8n credential references
  if ("credentials" in node) {
    delete node.credentials;
    removed.add("credentials");
  }

  const p = node.parameters;

  if (!p || typeof p !== "object") continue;

  /*
   * Replace common resource identifiers with placeholders.
   */

  // Telegram chat ID
  if ("chatId" in p && typeof p.chatId === "string") {
    p.chatId = "YOUR_CHAT_ID";
    replaced.add("Telegram chat ID");
  }

  // Google Sheets document ID
  if (
    p.documentId &&
    typeof p.documentId === "object" &&
    "value" in p.documentId
  ) {
    p.documentId.value = "YOUR_SPREADSHEET_ID";
    replaced.add("Google Sheets spreadsheet ID");
  }

  // Slack channel ID
  if (
    p.channelId &&
    typeof p.channelId === "object" &&
    "value" in p.channelId
  ) {
    p.channelId.value = "YOUR_CHANNEL_ID";
    p.channelId.mode = "id";
    replaced.add("Slack channel ID");
  }

  // Slack channel ID if represented directly as a string
  if ("channelId" in p && typeof p.channelId === "string") {
    p.channelId = "YOUR_CHANNEL_ID";
    replaced.add("Slack channel ID");
  }
}

/* =========================================================
   3. Remove credential-like fields recursively
   ========================================================= */

const SECRET_FIELD_NAMES = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "clientsecret",
  "client_secret",
  "clientSecret",
  "apikey",
  "api_key",
  "apiKey",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "auth_token",
  "authToken",
  "bot_token",
  "botToken",
  "private_key",
  "privateKey",
  "privatekey",
  "secret_key",
  "secretKey",
  "signing_secret",
  "signingSecret",
  "webhook_secret",
  "webhookSecret",
]);

function looksLikeSecretField(key) {
  const normalized = String(key)
    .replace(/[-_\s]/g, "")
    .toLowerCase();

  return (
    SECRET_FIELD_NAMES.has(key) ||
    normalized.includes("apikey") ||
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("clientsecret") ||
    normalized.includes("privatekey") ||
    normalized.includes("webhooksecret") ||
    normalized.includes("bot_token".replace(/_/g, "")) ||
    normalized.includes("password")
  );
}

function sanitizeObject(obj, path = "") {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      obj[i] = sanitizeObject(obj[i], `${path}[${i}]`);
    }

    return obj;
  }

  if (!obj || typeof obj !== "object") {
    return obj;
  }

  for (const key of Object.keys(obj)) {
    const currentPath = path ? `${path}.${key}` : key;

    // Remove any nested credentials object
    if (key === "credentials") {
      delete obj[key];
      removed.add("nested credentials");
      continue;
    }

    // Remove obvious secret fields
    if (looksLikeSecretField(key)) {
      delete obj[key];
      removed.add(currentPath);
      continue;
    }

    obj[key] = sanitizeObject(obj[key], currentPath);
  }

  return obj;
}

wf = sanitizeObject(wf);

/* =========================================================
   4. Remove cached URLs
   ========================================================= */

function stripCachedUrls(obj) {
  if (Array.isArray(obj)) {
    obj.forEach(stripCachedUrls);
    return;
  }

  if (obj && typeof obj === "object") {
    if ("cachedResultUrl" in obj) {
      delete obj.cachedResultUrl;
      removed.add("cachedResultUrl");
    }

    Object.values(obj).forEach(stripCachedUrls);
  }
}

stripCachedUrls(wf);

/* =========================================================
   5. Detect and replace common exposed API keys/tokens
   ========================================================= */

function sanitizeString(value, path) {
  if (typeof value !== "string") {
    return value;
  }

  let result = value;

  /*
   * OpenAI API keys
   * Example:
   * sk-xxxxxxxxxxxxxxxx
   */
  result = result.replace(
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    "YOUR_OPENAI_API_KEY"
  );

  /*
   * Google / Gemini API keys
   */
  result = result.replace(
    /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    "YOUR_GOOGLE_OR_GEMINI_API_KEY"
  );

  /*
   * Slack tokens
   */
  result = result.replace(
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    "YOUR_SLACK_TOKEN"
  );

  /*
   * Slack webhook URLs
   */
  result = result.replace(
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
    "YOUR_SLACK_WEBHOOK_URL"
  );

  /*
   * Telegram bot tokens
   *
   * Typical format:
   * 123456789:AAxxxxxxxxxxxxxxxx
   */
  result = result.replace(
    /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
    "YOUR_TELEGRAM_BOT_TOKEN"
  );

  /*
   * Discord webhook URLs
   */
  result = result.replace(
    /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
    "YOUR_DISCORD_WEBHOOK_URL"
  );

  /*
   * GitHub personal access tokens
   */
  result = result.replace(
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    "YOUR_GITHUB_TOKEN"
  );

  /*
   * Hugging Face tokens
   */
  result = result.replace(
    /\bhf_[A-Za-z0-9]{20,}\b/g,
    "YOUR_HUGGINGFACE_TOKEN"
  );

  /*
   * Anthropic API keys
   */
  result = result.replace(
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    "YOUR_ANTHROPIC_API_KEY"
  );

  if (result !== value) {
    replaced.add(`secret-like value at ${path}`);
  }

  return result;
}

function scanAndSanitizeStrings(obj, path = "") {
  if (Array.isArray(obj)) {
    return obj.map((value, index) =>
      scanAndSanitizeStrings(value, `${path}[${index}]`)
    );
  }

  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj)) {
      const currentPath = path ? `${path}.${key}` : key;

      if (typeof obj[key] === "string") {
        obj[key] = sanitizeString(obj[key], currentPath);
      } else {
        obj[key] = scanAndSanitizeStrings(obj[key], currentPath);
      }
    }

    return obj;
  }

  return obj;
}

wf = scanAndSanitizeStrings(wf);

/* =========================================================
   6. Sanity checks
   ========================================================= */

const problems = [];

const ids = wf.nodes.map((n) => n.id);

if (new Set(ids).size !== ids.length) {
  problems.push("Duplicate node IDs found.");
}

const names = new Set(wf.nodes.map((n) => n.name));

for (const [from, outputs] of Object.entries(wf.connections || {})) {
  if (!names.has(from)) {
    problems.push(`Connection from unknown node "${from}".`);
  }

  for (const branches of Object.values(outputs || {})) {
    for (const branch of branches || []) {
      for (const link of branch || []) {
        if (!names.has(link.node)) {
          problems.push(
            `Connection to unknown node "${link.node}".`
          );
        }
      }
    }
  }
}

/* =========================================================
   7. Final secret scan
   ========================================================= */

const text = JSON.stringify(wf);

/*
 * UUIDs are common in n8n and aren't necessarily secrets,
 * so remove them before the suspicious-string scan.
 */
const uuid =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const withoutUuids = text.replace(uuid, "");

const suspicious = [
  [/https?:\/\/docs\.google\.com\/[^\s"']+/i, "a Google Docs/Sheets URL"],
  [/hooks\.slack\.com/i, "a Slack webhook URL"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/i, "a Slack token"],
  [/\d{8,12}:[A-Za-z0-9_-]{30,}/, "a Telegram bot token"],
  [/AIza[0-9A-Za-z_-]{20,}/, "a Google/Gemini API key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic API key"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "an OpenAI-style API key"],
  [/gh[pousr]_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/hf_[A-Za-z0-9]{20,}/, "a Hugging Face token"],
  [
    /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/i,
    "a Discord webhook",
  ],
];

for (const [pattern, label] of suspicious) {
  if (pattern.test(withoutUuids)) {
    warnings.push(`Still contains ${label}. Search the output file for it.`);
  }
}

/* =========================================================
   8. Write sanitized workflow
   ========================================================= */

try {
  fs.writeFileSync(
    outputPath,
    JSON.stringify(wf, null, 2) + "\n",
    "utf8"
  );
} catch (error) {
  console.error(`Could not write "${outputPath}".`);
  console.error(error.message);
  process.exit(1);
}

/* =========================================================
   9. Report
   ========================================================= */

console.log(`Cleaned "${wf.name || "Unnamed workflow"}" -> ${outputPath}`);
console.log(`Nodes: ${wf.nodes.length}`);

console.log(
  `Removed: ${
    [...removed].join(", ") || "nothing"
  }`
);

console.log(
  `Replaced: ${
    [...replaced].join(", ") || "nothing"
  }`
);

if (problems.length) {
  console.log("\nWorkflow checks found problems:");

  problems.forEach((problem) => {
    console.log(`  - ${problem}`);
  });
}

if (warnings.length) {
  console.log("\nSecurity warnings:");

  warnings.forEach((warning) => {
    console.log(`  - ${warning}`);
  });
}

if (!problems.length && !warnings.length) {
  console.log(
    "Checks passed: unique node IDs, valid connections, and no detected common credentials/secrets."
  );
}

if (problems.length || warnings.length) {
  process.exitCode = 1;
}