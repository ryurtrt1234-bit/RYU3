// /api/deploy が push したコミットが、Vercel上の本番デプロイとして反映完了(READY)したかを
// vercel CLI経由で確認するためのポーリング用API。ローカル開発時のみ有効。
import { execFile } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";

const REPO_ROOT = process.cwd().replace(/\/ryu3$/, "");
const PROJECT_DIR = `${REPO_ROOT}/ryu3`;

type VercelDeployment = {
  state: string;
  url: string;
  meta?: { githubCommitSha?: string };
};

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      { status: "error", message: "このエンドポイントはローカル開発時のみ利用できます。" },
      { status: 403 }
    );
  }

  const sha = request.nextUrl.searchParams.get("sha");
  if (!sha) {
    return NextResponse.json({ status: "error", message: "sha が指定されていません。" }, { status: 400 });
  }

  try {
    const out = await run(
      "npx",
      ["--no-install", "vercel", "ls", "--json", "--meta", `githubCommitSha=${sha}`],
      PROJECT_DIR
    );
    const parsed = JSON.parse(out) as { deployments: VercelDeployment[] };
    const match = parsed.deployments?.[0];

    if (!match) {
      // まだVercel側にデプロイが作成されていない（push直後でキュー待ち）
      return NextResponse.json({ status: "pending" });
    }

    return NextResponse.json({ status: match.state, url: match.url });
  } catch (e) {
    return NextResponse.json(
      { status: "error", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
