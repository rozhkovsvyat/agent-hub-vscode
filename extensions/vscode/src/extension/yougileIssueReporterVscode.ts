import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  yougileIssueReporterForHost,
  type YougileIssueReporter,
} from "./yougileIssueReporter";

export function yougileIssueReporterForContext(
  context: vscode.ExtensionContext,
): YougileIssueReporter {
  return yougileIssueReporterForHost(context, {
    storageRoot: path.join(context.globalStorageUri.fsPath, "issue-reports"),
    store: context.secrets,
    extensionVersion: String(
      context.extension.packageJSON.version ?? "unknown",
    ),
    vscodeVersion: vscode.version,
    operatingSystem: `${os.platform()} ${os.release()} ${os.arch()}`,
    remote: () => vscode.env.remoteName ?? "local",
    workspace: () =>
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.name),
    logRoot: context.logUri.fsPath,
  });
}

export function startYougileIssueOutbox(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  const reporter = yougileIssueReporterForContext(context);
  reporter.start();
  return new vscode.Disposable(() => reporter.dispose());
}
