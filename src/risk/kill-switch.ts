export class KillSwitch {
  private enabled = false;
  private reason: string = '';

  enable(reason: string): void {
    this.enabled = true;
    this.reason = reason;
  }

  disable(): void {
    this.enabled = false;
    this.reason = '';
  }

  status(): { enabled: boolean; reason: string } {
    return { enabled: this.enabled, reason: this.reason };
  }
}
