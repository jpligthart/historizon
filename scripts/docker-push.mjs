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

const SOURCE_URL = "https://github.com/jpligthart/historizon";

const images = [
  {
    name: "historizon-api",
    dockerfile: "apps/api/Dockerfile",
    pkg: "apps/api/package.json",
    description: "Historizon API: timeline data (SQLite + FTS5) and cached Wikipedia extracts",
  },
  {
    name: "historizon-web",
    dockerfile: "apps/web/Dockerfile",
    pkg: "apps/web/package.json",
    description: "Historizon web: zoomable timeline of what happened at the same time",
  },
];

function gitRevision() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (r.status !== 0) return "unknown";
  const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim();
  return r.stdout.trim() + (dirty ? "-dirty" : "");
}

const revision = gitRevision();
const created = new Date().toISOString();

for (const image of images) {
  const tag = `${IMAGE_REGISTRY}/${image.name}:${IMAGE_TAG}`;
  const pkgVersion = JSON.parse(readFileSync(resolve(process.cwd(), image.pkg), "utf8")).version;
  const version = IMAGE_TAG !== "latest" ? IMAGE_TAG : pkgVersion;
  // Labels live in the Dockerfile; build args fill in the dynamic ones. Multi-arch pushes
  // produce an image index, so repeat the key annotations there (GHCR reads them from the index).
  const indexAnnotations = {
    "org.opencontainers.image.source": SOURCE_URL,
    "org.opencontainers.image.description": image.description,
    "org.opencontainers.image.licenses": "AGPL-3.0-or-later",
  };
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
    "--build-arg",
    `VERSION=${version}`,
    "--build-arg",
    `REVISION=${revision}`,
    "--build-arg",
    `CREATED=${created}`,
    ...Object.entries(indexAnnotations).flatMap(([k, v]) => ["--annotation", `index:${k}=${v}`]),
    ".",
  ];
  console.log(`Pushing ${tag}`);
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
