/**
 * Keeps an asynchronous initial IDE query from overwriting a later selection
 * push. The epoch advances for every request and every live update.
 */
export class CukiiActiveEditorSelectionState {
  private epoch = 0;
  private hasSelection = false;

  beginInitialQuery(): number {
    this.epoch += 1;
    return this.epoch;
  }

  applyInitialResponse(epoch: number, hasSelection: boolean): boolean {
    if (epoch !== this.epoch) {
      return false;
    }
    this.hasSelection = hasSelection;
    return true;
  }

  applyLiveUpdate(hasSelection: boolean): void {
    this.epoch += 1;
    this.hasSelection = hasSelection;
  }

  clear(): void {
    this.epoch += 1;
    this.hasSelection = false;
  }

  value(): boolean {
    return this.hasSelection;
  }
}
