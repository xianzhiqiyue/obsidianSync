import { App, Modal, Setting } from "obsidian";
import type { SyncConflict } from "./api-client";

export type ConflictResolutionAction = "use_local" | "use_remote" | "defer";

export interface ConflictResolutionCandidate {
  id: string;
  code: string;
  path: string;
  fileId?: string;
  message: string;
  localExists: boolean;
  localIsConflictCopy: boolean;
  localPreview: string | null;
  remoteSummary: string | null;
  recommendedAction: ConflictResolutionAction;
  recommendedReason: string;
}

export interface ConflictResolutionModalResult {
  action: "apply" | "defer";
  selections: Record<string, ConflictResolutionAction>;
}

export class ConflictResolutionModal extends Modal {
  private readonly selections: Record<string, ConflictResolutionAction>;
  private readonly done: (result: ConflictResolutionModalResult) => void;
  private resolved = false;

  constructor(
    app: App,
    private readonly conflicts: ConflictResolutionCandidate[],
    done: (result: ConflictResolutionModalResult) => void
  ) {
    super(app);
    this.done = done;
    this.selections = Object.fromEntries(conflicts.map((item) => [item.id, item.recommendedAction]));
  }

  override onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("处理同步冲突");
    contentEl.empty();

    contentEl.createEl("p", {
      text: `发现 ${this.conflicts.length} 个冲突。请为每个文件选择保留本地、保留远端，或稍后再处理。`
    });

    for (const conflict of this.conflicts) {
      const section = contentEl.createDiv({ cls: "custom-sync-conflict-item" });
      section.createEl("h4", { text: `${conflict.code} · ${conflict.path}` });

      const details = [
        `本地存在：${conflict.localExists ? "是" : "否"}`,
        `文件 ID：${conflict.fileId ?? "-"}`,
        `原因：${conflict.message}`
      ].join("\n");
      section.createEl("pre", { text: details });
      if (conflict.remoteSummary) {
        section.createEl("p", { text: "远端信息" });
        section.createEl("pre", { text: conflict.remoteSummary });
      }
      if (conflict.localPreview) {
        section.createEl("p", { text: "本地预览" });
        section.createEl("pre", { text: conflict.localPreview });
      }

      new Setting(section)
        .setName("处理动作")
        .setDesc(this.describeAction(conflict.recommendedAction, conflict.recommendedReason))
        .addDropdown((dropdown) => {
          dropdown
            .addOption("use_local", "使用本地文件")
            .addOption("use_remote", "使用远端结果")
            .addOption("defer", "稍后处理")
            .setValue(this.selections[conflict.id] ?? conflict.recommendedAction)
            .onChange((value) => {
              const next = value as ConflictResolutionAction;
              this.selections[conflict.id] = next;
              const descEl = section.querySelector(".setting-item-description");
              if (descEl) {
                descEl.textContent = this.describeAction(next, conflict.recommendedReason);
              }
            });
        });
    }

    const buttonBar = contentEl.createDiv({ cls: "custom-sync-conflict-actions" });
    new Setting(buttonBar)
      .addButton((button) =>
        button.setButtonText("全部使用本地并应用").onClick(() => {
          this.finishWithBulkAction("use_local");
        })
      )
      .addButton((button) =>
        button.setButtonText("全部使用远端并应用").onClick(() => {
          this.finishWithBulkAction("use_remote");
        })
      )
      .addButton((button) =>
        button.setButtonText("稍后处理").onClick(() => {
          this.finish({ action: "defer", selections: { ...this.selections } });
        })
      )
      .addButton((button) =>
        button.setCta().setButtonText("应用决策").onClick(() => {
          this.finish({ action: "apply", selections: { ...this.selections } });
        })
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.done({ action: "defer", selections: { ...this.selections } });
    }
  }

  private finishWithBulkAction(action: ConflictResolutionAction): void {
    for (const conflict of this.conflicts) {
      this.selections[conflict.id] = action;
    }
    this.finish({ action: "apply", selections: { ...this.selections } });
  }

  private finish(result: ConflictResolutionModalResult): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.done(result);
    this.close();
  }

  private describeAction(action: ConflictResolutionAction, reason: string): string {
    if (action === "use_local") {
      return `恢复本地待解决内容到原路径，后续将以本地版本重新提交。建议原因：${reason}`;
    }
    if (action === "use_remote") {
      return `接受远端当前状态，本地会回到远端结果。建议原因：${reason}`;
    }
    return `暂不处理，保留待决冲突，后续手动再次同步。建议原因：${reason}`;
  }
}

export function openConflictResolutionModal(
  app: App,
  conflicts: ConflictResolutionCandidate[]
): Promise<ConflictResolutionModalResult> {
  return new Promise((resolve) => {
    const modal = new ConflictResolutionModal(app, conflicts, resolve);
    modal.open();
  });
}

class ConflictAcknowledgeModal extends Modal {
  constructor(
    app: App,
    private readonly conflicts: SyncConflict[],
    private readonly done: () => void
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("同步冲突待处理");
    contentEl.empty();
    contentEl.createEl("p", {
      text: `发现 ${this.conflicts.length} 个冲突。已保存本地待解决内容，并已回放服务器最新状态。请先处理这些冲突，再重新同步。`
    });

    for (const conflict of this.conflicts) {
      const section = contentEl.createDiv({ cls: "custom-sync-conflict-item" });
      section.createEl("h4", { text: `${conflict.code} · ${conflict.path}` });
      section.createEl("pre", {
        text: [
          `文件 ID：${conflict.fileId ?? "-"}`,
          `原因：${conflict.message}`,
          `远端已删除：${conflict.remoteDeleted ? "是" : "否"}`
        ].join("\n")
      });
    }

    new Setting(contentEl).addButton((button) =>
      button.setCta().setButtonText("我知道了").onClick(() => {
        this.close();
      })
    );
  }

  override onClose(): void {
    this.contentEl.empty();
    this.done();
  }
}

export function openConflictAcknowledgeModal(app: App, conflicts: SyncConflict[]): Promise<void> {
  return new Promise((resolve) => {
    const modal = new ConflictAcknowledgeModal(app, conflicts, resolve);
    modal.open();
  });
}
