/**
 * QwenProxy - Live Quota & Token Limit Calibration Benchmark
 *
 * Runs an unbounded stress loop against a single sticky account until Alibaba
 * definitively triggers the hard daily quota cutoff (RateLimited / membership_limit),
 * logging:
 *  - Real prompt tokens & completion tokens per turn
 *  - Cumulative tokens & messages until quota exhaustion
 *  - Exact upstream cutoff error payload
 *  - Extracted wait time from Alibaba hint + exact calculated UTC midnight reset time (Brasília)
 *  - TTFB and streaming latency
 *
 * Usage:
 *   npx tsx src/benchmarks/quota-calibration.ts --model=qwen3.7-plus --account=qwen.cgnx3
 *   npx tsx src/benchmarks/quota-calibration.ts --model=qwen3.8-max --account=jgctbr
 */

import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { estimateTokenCount } from "../utils/context-truncation.ts";

function parseArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const MODEL = parseArg("model", "qwen3.7-plus");
const BASE_URL = parseArg("url", "http://127.0.0.1:7936/v1/chat/completions");
const API_KEY = parseArg("key", process.env.API_KEY || "sk-qwenproxy-local");
const PROMPT_KB = parseInt(parseArg("prompt-kb", "15"), 10);
const MAX_TURNS = parseInt(parseArg("max-turns", "300"), 10);
const TARGET_ACCOUNT = parseArg("account", "qwen.cgnx3");

function generateLargePrompt(kbSize: number, turnIndex: number): string {
  const baseInstruction = `Você é um Arquiteto de Software Principal. Analise detalhadamente esta arquitetura distribuída (Turno #${turnIndex}) e forneça uma resposta completa, técnica, profunda e extensa (pelo menos 800 a 1500 palavras) explicando otimizações de concorrência, consistência de cache e tolerância a falhas.\n\n`;

  const codeChunk = `
// --- MÓDULO DE SERVIÇOS DISTRIBUÍDOS #${turnIndex} ---
interface DistributedStateNode {
  nodeId: string;
  clusterTerm: number;
  commitIndex: number;
  state: "leader" | "follower" | "candidate";
  peers: Array<{ endpoint: string; latencyMs: number; healthy: boolean }>;
  replicatedLog: Array<{ term: number; command: string; payload: Record<string, unknown> }>;
}

class ClusterConsensusCoordinator {
  private peers: Map<string, DistributedStateNode> = new Map();
  private heartbeatIntervalMs: number = 150;
  private electionTimeoutMinMs: number = 300;
  private electionTimeoutMaxMs: number = 600;

  async broadcastAppendEntries(term: number, leaderId: string): Promise<boolean> {
    const promises = Array.from(this.peers.values()).map(async (peer) => {
      return { peerId: peer.nodeId, ack: true, matchIndex: peer.commitIndex };
    });
    const results = await Promise.allSettled(promises);
    return results.filter(r => r.status === "fulfilled").length >= Math.ceil(this.peers.size / 2);
  }
}
`;

  let prompt = baseInstruction;
  while (Buffer.byteLength(prompt, "utf8") < kbSize * 1024) {
    prompt += codeChunk;
  }
  return prompt;
}

function isRealQuotaCutoff(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("membership_limit") ||
    lower.includes("update_member") ||
    lower.includes("upper limit for today's usage") ||
    lower.includes("you've reached the upper limit") ||
    lower.includes("allocated quota exceeded") ||
    lower.includes("ratelimited") ||
    lower.includes("quota exceeded") ||
    lower.includes("alcançou o limite") ||
    lower.includes("atingiu o limite")
  );
}

function extractWaitHint(text: string): string | null {
  const match = text.match(/Wait about\s+(\d+)\s+hour\(s\)/i);
  if (match) return `${match[1]} hora(s)`;
  return null;
}

interface TurnMetrics {
  turn: number;
  ttfbMs: number;
  totalMs: number;
  promptChars: number;
  estimatedPromptTokens: number;
  outputChars: number;
  estimatedOutputTokens: number;
  reportedPromptTokens?: number;
  reportedCompletionTokens?: number;
  account: string;
  cutoffDetected: boolean;
  cutoffMessage?: string;
}

async function main() {
  console.log("================================================================");
  console.log(` 🔬 QwenProxy - Teste de Cota Extrema: [${MODEL}]`);
  console.log("================================================================");
  console.log(`📡 Endpoint:         ${BASE_URL}`);
  console.log(`🤖 Modelo Alvo:      ${MODEL}`);
  console.log(`👤 Conta Alvo:       ${TARGET_ACCOUNT}`);
  console.log(`📦 Tamanho Prompt:   ~${PROMPT_KB} KB por requisição`);
  console.log(`🔁 Modo Sem Limite:  Até a Alibaba cortar (teto max: ${MAX_TURNS} turnos)`);
  console.log("----------------------------------------------------------------\n");

  try {
    const healthCheck = await fetch(BASE_URL.replace("/v1/chat/completions", "/health"), {
      signal: AbortSignal.timeout(3000),
    });
    if (!healthCheck.ok) {
      console.warn("⚠️ Servidor respondeu com status não-200 no /health");
    }
  } catch (err: any) {
    console.error(`❌ O servidor QwenProxy não está rodando em ${BASE_URL}.`);
    console.error("👉 Abra outro terminal e execute: npm run start\n");
    process.exit(1);
  }

  const sessionId = `calibration-${MODEL}-${Date.now()}`;
  const conversationMessages: Array<{ role: string; content: string }> = [];

  const turnHistory: TurnMetrics[] = [];
  let cumulativePromptTokens = 0;
  let cumulativeOutputTokens = 0;
  let targetAccount: string | null = null;
  let activeAccount = TARGET_ACCOUNT;
  let cutoffError: string | null = null;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const prompt = generateLargePrompt(PROMPT_KB, turn);
    const estPromptTokens = estimateTokenCount(prompt);

    conversationMessages.push({ role: "user", content: prompt });

    const startedAt = performance.now();
    let ttfbMs = 0;
    let outputText = "";
    let reportedPromptTokens: number | undefined;
    let reportedCompletionTokens: number | undefined;
    let turnAccount = activeAccount;
    let cutoffDetected = false;
    let cutoffMessage = "";
    let isTransientError = false;

    process.stdout.write(`⏳ Turno #${turn} enviando (${estPromptTokens} est. tokens)... `);

    try {
      const response = await fetch(BASE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "x-session-id": sessionId,
          ...(TARGET_ACCOUNT ? { "x-qwenproxy-account": TARGET_ACCOUNT } : {}),
        },
        body: JSON.stringify({
          model: MODEL,
          messages: conversationMessages,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });

      const respAccount = response.headers.get("x-qwenproxy-account");
      if (respAccount) {
        if (!targetAccount) {
          targetAccount = respAccount;
          activeAccount = respAccount;
          console.log(`\n🎯 Conta confirmada para exaustão: [${targetAccount}]`);
          process.stdout.write(`⏳ Turno #${turn} continuando... `);
        } else if (respAccount !== targetAccount) {
          cutoffDetected = true;
          cutoffMessage = `Conta alvo [${targetAccount}] atingiu a cota diária e o proxy rotacionou para [${respAccount}]. Parando para não consumir a próxima conta.`;
        }
        turnAccount = respAccount;
      }

      if (response.status === 429) {
        const errorBody = await response.text();
        cutoffDetected = true;
        cutoffMessage = `HTTP 429: ${errorBody}`;
      } else if (!response.body) {
        throw new Error(`Sem corpo de resposta (status: ${response.status})`);
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (ttfbMs === 0) {
            ttfbMs = Math.round(performance.now() - startedAt);
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.replace(/^data:\s*/, "").trim();
            if (dataStr === "[DONE]") break;

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.choices?.[0]?.delta?.content) {
                outputText += parsed.choices[0].delta.content;
              }
              if (parsed.usage) {
                reportedPromptTokens = parsed.usage.prompt_tokens;
                reportedCompletionTokens = parsed.usage.completion_tokens;
              }
            } catch {}
          }
        }
      }
    } catch (reqError: any) {
      const errMsg = reqError.message || String(reqError);
      if (isRealQuotaCutoff(errMsg)) {
        cutoffDetected = true;
        cutoffMessage = errMsg;
      } else {
        isTransientError = true;
        cutoffMessage = errMsg;
      }
    }

    const totalMs = Math.round(performance.now() - startedAt);
    const estOutputTokens = estimateTokenCount(outputText);

    // Check for hard quota cutoff in output text
    if (!cutoffDetected && isRealQuotaCutoff(outputText)) {
      cutoffDetected = true;
      cutoffMessage = outputText.trim();
    }

    if (cutoffDetected) {
      cutoffError = cutoffMessage;
      console.log(`\n\n🚨 PARADA REAL: COTA DIÁRIA DA ALIBABA ESGOTADA NO TURNO #${turn}!`);
      console.log(`   Conta:   ${turnAccount}`);
      console.log(`   Detalhe: ${cutoffMessage}\n`);
      break;
    }

    if (isTransientError || (outputText.includes("network error") && !isRealQuotaCutoff(outputText))) {
      console.log(`\n⚠️  [Oscilação temporária de rede / timeout]: ${cutoffMessage || "network error"}. Continuando teste em 3s...`);
      // Pop the failed turn prompt and retry
      conversationMessages.pop();
      turn--; // Retry this turn index
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    const effectivePromptTokens = reportedPromptTokens ?? estPromptTokens;
    const effectiveOutputTokens = reportedCompletionTokens ?? estOutputTokens;

    cumulativePromptTokens += effectivePromptTokens;
    cumulativeOutputTokens += effectiveOutputTokens;

    const metric: TurnMetrics = {
      turn,
      ttfbMs,
      totalMs,
      promptChars: prompt.length,
      estimatedPromptTokens: estPromptTokens,
      outputChars: outputText.length,
      estimatedOutputTokens: estOutputTokens,
      reportedPromptTokens,
      reportedCompletionTokens,
      account: turnAccount,
      cutoffDetected: false,
    };
    turnHistory.push(metric);

    console.log(
      `✅ OK (${totalMs}ms | TTFB ${ttfbMs}ms | Out: ${effectiveOutputTokens} tok | Acumulado: ${(cumulativePromptTokens + cumulativeOutputTokens).toLocaleString("pt-BR")} tok)`,
    );
    conversationMessages.push({ role: "assistant", content: outputText.slice(0, 500) });

    await new Promise((r) => setTimeout(r, 1000));
  }

  // ─── Post-Run Calculations ───────────────────────────────────────────────────

  const now = Date.now();
  const nextMidnightUtc = new Date(now);
  nextMidnightUtc.setUTCHours(24, 0, 0, 0);
  const msUntilMidnight = Math.max(0, nextMidnightUtc.getTime() - now);
  const minutesUntilMidnight = Math.round(msUntilMidnight / 60000);
  const hoursUntilMidnight = (msUntilMidnight / 3600000).toFixed(1);

  // Time in Brasília timezone (UTC-3)
  const alibabaHint = cutoffError ? extractWaitHint(cutoffError) : null;

  console.log("\n================================================================");
  console.log(` 📊 DIAGNÓSTICO DEFINITIVO DE COTA [${MODEL}]`);
  console.log("================================================================");
  console.log(`👤 Conta Testada:              ${activeAccount}`);
  console.log(`🎯 Turnos Realizados:          ${turnHistory.length}`);
  console.log(`📥 Tokens de Entrada Totais:     ${cumulativePromptTokens.toLocaleString("pt-BR")}`);
  console.log(`📤 Tokens de Saída Totais:       ${cumulativeOutputTokens.toLocaleString("pt-BR")}`);
  console.log(`💎 COTA TOTAL CONSUMIDA:        ${(cumulativePromptTokens + cumulativeOutputTokens).toLocaleString("pt-BR")} tokens`);
  console.log("----------------------------------------------------------------");
  if (cutoffError) {
    console.log(`🛑 Mensagem Oficial da Alibaba: ${cutoffError}`);
    if (alibabaHint) {
      console.log(`⏱️  Estimativa de Espera Alibaba: ${alibabaHint}`);
    }
  }
  console.log(`🕒 HORA EXATA DO RESET (Brasília): 21:00 BRT (daqui a ~${hoursUntilMidnight}h / ${minutesUntilMidnight} minutos)`);
  console.log(`🔄 Cooldown no Proxy:          ${minutesUntilMidnight + 5}m cd (com 5m de margem de segurança)`);
  console.log("================================================================\n");

  const reportDir = path.resolve("docs");
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `CALIBRATION_${MODEL.toUpperCase()}.md`);

  const mdReport = `# Calibração Definitiva de Cota — Modelo ${MODEL}

- **Data do Teste:** ${new Date().toLocaleString("pt-BR")}
- **Conta Testada:** \`${activeAccount}\`
- **Modelo:** \`${MODEL}\`
- **Turnos Concluídos até Corte:** **${turnHistory.length}**
- **Tokens de Entrada Acumulados:** **${cumulativePromptTokens.toLocaleString("pt-BR")}**
- **Tokens de Saída Acumulados:** **${cumulativeOutputTokens.toLocaleString("pt-BR")}**
- **Cota Total Consumida:** **${(cumulativePromptTokens + cumulativeOutputTokens).toLocaleString("pt-BR")} tokens**
- **Estimativa de Espera da Alibaba:** **${alibabaHint || "N/A"}**
- **Hora Exata de Reset (Horário de Brasília):** **21:00 BRT** (~${hoursUntilMidnight} horas / ${minutesUntilMidnight} minutos restantes)
- **Erro de Corte Upstream:**
\`\`\`text
${cutoffError || "Nenhum corte (limite de turnos atingido)"}
\`\`\`

## Detalhamento Turno a Turno

| Turno | TTFB | Latência Total | Tokens Entrada | Tokens Saída | Status |
| :---: | :---: | :---: | :---: | :---: | :---: |
${turnHistory.map((t) => `| #${t.turn} | ${t.ttfbMs}ms | ${t.totalMs}ms | ${t.reportedPromptTokens ?? t.estimatedPromptTokens} | ${t.reportedCompletionTokens ?? t.estimatedOutputTokens} | ✅ OK |`).join("\n")}
`;

  fs.writeFileSync(reportPath, mdReport, "utf8");
  console.log(`📝 Relatório salvo em: ${reportPath}\n`);
}

main().catch((e) => {
  console.error("Erro fatal na calibração:", e);
  process.exit(1);
});
