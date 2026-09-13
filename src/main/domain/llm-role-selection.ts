// domain/llm-role-selection — 저장된 LLM 역할 선택 한 칸의 모양.
// main 역할을 읽는 설정 어댑터(naia-settings-store loadMain)가 쓴다. 보조·기억·전문가 역할 해석(llm-roles)과 떨어져 있어,
// 그 역할들을 지워도 main 선택의 모양은 남는다(nextain/naia-shell#589).

export type LlmRole = "main" | "sub" | "memory" | "expert";

export interface LlmRoleSelection {
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly credentialRef?: string;
  readonly inherit?: LlmRole;
}
