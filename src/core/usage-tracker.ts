import { countTokens } from './tokenizer.js'

interface UserUsage {
  requestCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastRequestAt: number;
}

const userUsageMap = new Map<string, UserUsage>();
const modelUsageMap = new Map<string, number>();

export function trackUsage(userId: string, inputText: string, isError: boolean, outputTokens = 0, inputTokens?: number): void {
  const resolvedInput = inputTokens ?? countTokens(inputText);
  const existing = userUsageMap.get(userId);

  if (existing) {
    existing.requestCount += 1;
    existing.errorCount += isError ? 1 : 0;
    existing.inputTokens += resolvedInput;
    existing.outputTokens += outputTokens;
    existing.totalTokens += resolvedInput + outputTokens;
    existing.lastRequestAt = Date.now();
  } else {
    userUsageMap.set(userId, {
      requestCount: 1,
      errorCount: isError ? 1 : 0,
      inputTokens: resolvedInput,
      outputTokens,
      totalTokens: resolvedInput + outputTokens,
      lastRequestAt: Date.now(),
    });
  }
}

export function getUserUsage(userId: string): UserUsage | null {
  const usage = userUsageMap.get(userId);
  return usage ? { ...usage } : null;
}

export function getAllUsage(): Array<{ userId: string } & UserUsage> {
  return Array.from(userUsageMap.entries()).map(([userId, usage]) => ({
    userId,
    ...usage,
  }));
}

export function getTopUsers(limit: number = 10): Array<{ userId: string } & UserUsage> {
  return getAllUsage()
    .sort((a, b) => b.requestCount - a.requestCount)
    .slice(0, limit);
}

export function resetUsage(): void {
  userUsageMap.clear();
  modelUsageMap.clear();
}

export function trackModelUsage(model: string): void {
  modelUsageMap.set(model, (modelUsageMap.get(model) ?? 0) + 1);
}

export function getModelUsage(): Record<string, number> {
  return Object.fromEntries(modelUsageMap);
}
