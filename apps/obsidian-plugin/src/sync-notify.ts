export interface NotifyPolicyInput {
  interactive: boolean;
  nowMs: number;
  lastNoticeAtMs: number;
  cooldownMs: number;
}

export interface FailureNotifyPolicyInput extends NotifyPolicyInput {
  consecutiveFailures: number;
  minConsecutiveFailures: number;
}

export function shouldNotifyBlocked(input: NotifyPolicyInput): boolean {
  if (input.interactive) {
    return true;
  }
  return input.nowMs - input.lastNoticeAtMs >= input.cooldownMs;
}

export function shouldNotifyFailure(input: FailureNotifyPolicyInput): boolean {
  if (input.interactive) {
    return true;
  }
  if (input.consecutiveFailures < input.minConsecutiveFailures) {
    return false;
  }
  return input.nowMs - input.lastNoticeAtMs >= input.cooldownMs;
}
