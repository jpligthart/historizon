import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function readEnvKeys(filePath, keys) {
  const text = readFileSync(filePath, "utf8");
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!keys.includes(key)) continue;
    out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const envPath = resolve(process.cwd(), ".env");
const { IMAGE_REGISTRY, IMAGE_TAG = "latest", IMAGE_PLATFORMS = "linux/amd64,linux/arm64" } =
  readEnvKeys(envPath, ["IMAGE_REGISTRY", "IMAGE_TAG", "IMAGE_PLATFORMS"]);

if (!IMAGE_REGISTRY) {
  console.error("IMAGE_REGISTRY missing in .env");
  process.exit(1);
}

const images = [
  { name: "historizon-api", dockerfile: "apps/api/Dockerfile" },
  { name: "historizon-web", dockerfile: "apps/web/Dockerfile" },
];

for (const image of images) {
  const tag = `${IMAGE_REGISTRY}/${image.name}:${IMAGE_TAG}`;
  const args = [
    "buildx",
    "build",
    "--platform",
    IMAGE_PLATFORMS,
    "-f",
    image.dockerfile,
    "-t",
    tag,
    "--push",
    "--label",
    "org.opencontainers.image.source=https://github.com/example/historizon",
    "--label",
    `org.opencontainers.image.title=${image.name}`,
    ".",
  ];
  console.log(`Pushing ${tag}`);
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
