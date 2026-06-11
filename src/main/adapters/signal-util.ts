// adapters/signal-util — abort 상태 fail-safe 읽기.
// ⚠️ 위협경계: skill 의 signal 은 ChatTurnHandler 의 표준 `AbortController().signal`(aborted getter 결정론적·throw/flip 불가).
//    malformed/throwing-getter signal 은 발생 불가 = 범위 밖. isAborted 의 try 는 그래도 두는 추가 방어(비용 0).
export function isAborted(signal: AbortSignal | undefined): boolean {
  try { return signal?.aborted === true; } catch { return false; }
}
