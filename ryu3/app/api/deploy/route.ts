// ローカル開発時のみ使う「pushして本番反映」ボタン用API。
// このアプリはバックエンドDBを持たない前提だが、この経路だけは開発者がClaude Codeと
// 作業中のワークスペースをそのままGitHubへpushするための例外的なローカル専用エンドポイント。
// 本番（Vercel上のビルド）ではNODE_ENVがproductionになるため、下の判定で必ず拒否する。
import { execFile } from "node:child_process";
import { NextResponse } from "next/server";

// リポジトリのルート（.git がある場所）。このAPIファイルの配置から見て2階層上。
const REPO_ROOT = process.cwd().replace(/\/ryu3$/, "");

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

export async function POST() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      { status: "error", message: "このエンドポイントはローカル開発時のみ利用できます。" },
      { status: 403 }
    );
  }

  try {
    await run("git", ["add", "-A"], REPO_ROOT);

    const statusOut = await run("git", ["status", "--porcelain"], REPO_ROOT);
    if (!statusOut) {
      return NextResponse.json({ status: "no_changes" });
    }

    const now = new Date();
    const stamp = now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const commitMessage = `アプリのpushボタンからの変更（${stamp}）\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`;

    await run("git", ["commit", "-m", commitMessage], REPO_ROOT);
    await run("git", ["push", "origin", "main"], REPO_ROOT);
    const sha = await run("git", ["rev-parse", "HEAD"], REPO_ROOT);

    return NextResponse.json({ status: "pushed", sha });
  } catch (e) {
    return NextResponse.json(
      { status: "error", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
