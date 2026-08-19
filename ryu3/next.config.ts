import type { NextConfig } from "next";
import { execSync } from "node:child_process";

// 画面右上の「Ver.」表示用: ビルド時点のGitコミット（＝push）日時をISO 8601文字列として埋め込む。
// Vercelのビルド環境でも動作するよう、取得に失敗した場合はビルド時刻にフォールバックする。
function getBuildCommitTime(): string {
  try {
    return execSync("git log -1 --format=%cI").toString().trim();
  } catch {
    return new Date().toISOString();
  }
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  env: {
    NEXT_PUBLIC_BUILD_COMMIT_TIME: getBuildCommitTime(),
  },
};

export default nextConfig;
