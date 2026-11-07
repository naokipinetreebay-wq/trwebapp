#!/usr/bin/env node
/**
 * 各トレーニングを static export して trwebapp/<path>/ に配置する。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORTAL = path.resolve(import.meta.dirname, "..");

const APPS = [
  { repo: "dribblekeepTR", basePath: "/keep", dir: "keep" },
  { repo: "escapeTR", basePath: "/escape", dir: "escape" },
  { repo: "driveTR", basePath: "/drive", dir: "drive" },
  { repo: "fieldscanTR", basePath: "/fieldscan", dir: "fieldscan" },
  { repo: "randomgoalgameTR", basePath: "/randomgoal", dir: "randomgoal" },
  { repo: "peritapTR", basePath: "/peritap", dir: "peritap" },
  { repo: "saccadeTR", basePath: "/saccade", dir: "saccade" },
  { repo: "flashmemTR", basePath: "/flashmem", dir: "flashmem" },
  { repo: "numbertapTR", basePath: "/numbertap", dir: "numbertap" },
  { repo: "shuttletouchTR", basePath: "/shuttletouch", dir: "shuttletouch" },
];

const ROOM_CODE_TS = `"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

function readCodeFromLocation(paramsCode: string | undefined): string {
  if (typeof window !== "undefined") {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((p) => p === "r" || p === "d");
    const fromPath = marker >= 0 ? parts[marker + 1] || "" : "";
    if (fromPath && fromPath !== "_") return fromPath.toUpperCase();
    const fromQuery = new URLSearchParams(window.location.search).get("code") || "";
    if (fromQuery) return fromQuery.toUpperCase();
  }
  const raw = String(paramsCode || "");
  return raw && raw !== "_" ? raw.toUpperCase() : "";
}

/** Pages の basePath（/fieldscan など）付き Display URL */
export function displayJoinUrl(code: string): string {
  if (typeof window === "undefined" || !code) return "";
  const appPath = window.location.pathname.replace(new RegExp("/(r|d)(/.*)?$"), "");
  return \`\${window.location.origin}\${appPath}/d/?code=\${encodeURIComponent(code)}\`;
}

export function useRoomCode(): string {
  const params = useParams<{ code: string }>();
  const [code, setCode] = useState(() => readCodeFromLocation(params.code));

  useEffect(() => {
    setCode(readCodeFromLocation(params.code));
  }, [params.code]);

  return code;
}
`;

const LAYOUT_TSX = `export function generateStaticParams() {
  return [{ code: "_" }];
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
`;

function ensureRoomCode(appDir) {
  const lib = path.join(appDir, "src/lib/roomCode.ts");
  fs.writeFileSync(lib, ROOM_CODE_TS);
}

function writeNextConfig(appDir, basePath) {
  const configPath = path.join(appDir, "next.config.mjs");
  fs.writeFileSync(
    configPath,
    `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
  basePath: "${basePath}",
};

export default nextConfig;
`
  );
}

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}  (${cwd})`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

const only = process.argv[2];
for (const app of APPS) {
  if (only && app.dir !== only && app.repo !== only) continue;
  const appDir = path.join(ROOT, app.repo);
  console.log(`\n=== ${app.repo} → ${app.dir} ===`);
  ensureRoomCode(appDir);
  writeNextConfig(appDir, app.basePath);
  run("npm run build", appDir);
  const outDir = path.join(appDir, "out");
  const dest = path.join(PORTAL, app.dir);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(outDir, dest, { recursive: true });
  console.log(`copied to ${dest}`);
}

console.log("\nDone.");
