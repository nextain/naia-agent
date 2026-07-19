# UC-WIRE-V1 공통 실행 계약 — 2026-07-19

> GitHub: `nextain/naia-agent#89`
>
> 상태: P01~P05 결정론 검증 완료. Guardian PASS 및 독립 2-pass CLEAN.
> 로컬 Agent/Shell commit pair와 루트 동결 표식 기록 전의 freeze candidate.
>
> 목적: Codex, 이미지, Discord, RAG가 같은 채팅 경계를 서로 다르게 확장하지
> 않도록 additive wire v1을 먼저 고정한다.

## 1. P01 사용자 시나리오

### S-WIRE-01 기존 텍스트 대화

기존 사용자가 텍스트만 보내면 새 필드를 전혀 보내지 않아도 이전과 같은
`ChatRequest → text/usage/finish` 흐름을 사용한다. 선택 필드가 없다는 이유로
새 오류나 기본 channel/grounding 정책을 추정하지 않는다.

### S-WIRE-02 세션을 새로 시작하거나 이어가기

클라이언트는 로컬 `sessionId`와 별도로 provider 세션 동작을
`new | resume`으로 명시할 수 있다. `resume`은 agent가 전에 발급한 opaque
`providerSessionRef`만 받는다. 이 ref는 원시 thread id가 아니라 agent-side
handle이며 `{workspace, sessionId, channel identity, provider, model,
credential generation}`에 결속된다. provider의 원시 thread id·ref·인증정보는
진단 로그에 남기지 않는다. provider는 검증된 세션 의미만 `ProviderChatOpts`로
받는다.

### S-WIRE-03 이미지가 포함된 질문

사용자는 앱 전용 저장소에 먼저 보관된 PNG/JPEG/WebP 이미지를 메시지에
첨부한다. wire에는 bytes, base64, 임의 파일 경로 대신 bounded
`AttachmentRef`만 흐른다. 잘못된 MIME, 크기, opaque ref는 요청 전체를
fail-closed한다.

### S-WIRE-04 Discord 채널에서 지식 기반 질문

Discord ingress는 guild/channel/user/binding 격리 정보를 구조화
`ChannelContext`로, 지식 요구는 `GroundingRequest`로 전달한다. 이 값들을
system prompt 문자열에 숨겨 넣지 않는다. 요청의 `knowledgeScope`는 권한이
아니라 claim이다. agent는 신뢰 저장소의 binding과 channel/user/scope가 정확히
일치하는지 provider/retrieval 전에 검증한다. `required`인데 근거가 없으면
agent는 근거를 꾸미지 않고 `no_evidence | uncompiled | unavailable` 상태를
구조적으로 반환한 뒤 일반 답변을 생성하지 않는다.

### S-WIRE-05 구조화 결과 소비

Shell과 Discord 소비자는 본문 스트림과 별도로 grounding 상태·출처,
이미지 artifact, provider 세션 lifecycle, 안정 오류 코드를 받는다. 표시 문구는
각 클라이언트의 i18n이 소유하며 wire는 code만 보존한다.

### S-WIRE-06 역할별 LLM 설정 확인

설정 소비자는 `main | sub | memory` 각각의 유효 provider/model/credential
reference와 필드별 provenance(`explicit | inherit | legacy-inherit | default`)를
구분한다. credential reference는 비밀값이 아니라 OS 보안 저장소를 가리키는
opaque 이름이다. 역할 해석과 실제 라우팅은 후속 #88/#384가 구현한다.

## 2. 계약 타입

### 2.1 입력

```ts
type AttachmentRef = {
  id: string;
  kind: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  localRef: string;
};

type ChannelContext =
  | { kind: "shell" }
  | {
      kind: "discord";
      bindingId: string;
      guildId: string;
      channelId: string;
      userId: string;
    };

type GroundingRequest = {
  policy: "off" | "available" | "required";
  knowledgeScope: string;
};

type ProviderSessionRequest =
  | { mode: "new" }
  | { mode: "resume"; providerSessionRef: string };
```

- `ChatMessage.attachments?: AttachmentRef[]`
- `ChatRequest.channel?: ChannelContext`
- `ChatRequest.grounding?: GroundingRequest`
- `ChatRequest.providerSession?: ProviderSessionRequest`
- 기존 `ChatRequest.sessionId?: string`은 transcript/로컬 대화 격리 키로 유지한다.

`guildId`, `channelId`, `userId`는 모두 Discord snowflake의 decimal string이다.
`knowledgeScope`, id, ref는 trim된 비어 있지 않은 bounded string이어야 한다.
`providerSession`이 있으면 비어 있지 않은 `sessionId`도 반드시 있어야 한다.
`grounding`이 있으면 `channel`도 반드시 있어야 하며, 신규 grounding 요청이
channel 부재를 legacy shell로 추정하지 않는다.
Discord 요청은 신뢰 저장소의
`{bindingId,guildId,channelId,allowedUserIds,knowledgeScope}`와 전부 일치해야
한다. 불일치는 `WIRE_SCOPE_FORBIDDEN` 단일 terminal이며 retrieval/provider를
호출하지 않는다. Shell 요청은 현재 workspace의 허용 scope와 대조한다.

### 2.2 출력

```ts
type GroundingSource = {
  title: string;
  sourceUris: readonly string[];
};

type ImageArtifact = {
  id: string;
  kind: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  localRef: string;
  name?: string;
};
```

추가 `AgentEmit`:

- `grounding`: `status = grounded | no_evidence | uncompiled | unavailable`,
  `sources: GroundingSource[]`
- `artifact`: `artifact: ImageArtifact`
- `providerSession`: `sessionId`, `providerSessionRef`,
  `state = started | resumed | closed`
- 기존 `error`: `message`를 보존하고 선택적 안정 `code`를 추가

안정 오류 코드 v1:

- provider: `PROVIDER_NOT_INSTALLED`, `PROVIDER_LOGIN_REQUIRED`,
  `PROVIDER_AUTH_EXPIRED`, `PROVIDER_NETWORK`
- Discord: `DISCORD_TOKEN_MISSING`, `DISCORD_INTENTS_MISSING`,
  `DISCORD_NOT_INSTALLED`, `DISCORD_PERMISSION_DENIED`,
  `DISCORD_RATE_LIMITED`
- attachment: `ATTACHMENT_UNSUPPORTED_TYPE`, `ATTACHMENT_TOO_LARGE`,
  `ATTACHMENT_INVALID_REF`
- knowledge: `KNOWLEDGE_UNCOMPILED`, `KNOWLEDGE_UNAVAILABLE`
- contract: `WIRE_INVALID_ARGUMENT`, `WIRE_UNSUPPORTED_ENUM`
- isolation/session: `WIRE_SCOPE_FORBIDDEN`, `PROVIDER_SESSION_MISMATCH`,
  `PROVIDER_SESSION_EXPIRED`, `PROVIDER_SESSION_CLOSED`

### 2.3 LLM 역할과 provenance

```ts
type LlmRole = "main" | "sub" | "memory";
type ConfigProvenance = "explicit" | "inherit" | "legacy-inherit" | "default";
type ResolvedConfigValue = {
  value: string;
  provenance: ConfigProvenance;
  inheritedFromRole?: LlmRole;
};
type EffectiveLlmConfig = {
  role: LlmRole;
  provider: ResolvedConfigValue;
  model: ResolvedConfigValue;
  credentialRef?: ResolvedConfigValue;
};
```

gRPC `SetWorkspaceResult`에 `repeated EffectiveLlmConfig`를 additive field로
추가한다. #89는 타입·codec round-trip만 고정하고, 실제 역할별 해석과 값 채움은
#88/#384가 소유한다. 빈 repeated 값은 기존 단일 `provider/model` 응답과 동형이다.
값이 있으면 role은 중복 없이 정확히 `main, sub, memory` 3개이며 이 순서로
정렬한다. partial list는 허용하지 않는다.
`inheritedFromRole`은 provenance가 `inherit | legacy-inherit`일 때만 허용한다.

### 2.4 enum presence와 표기

domain과 stdio JSON은 이 문서의 문자열을 그대로 쓴다. 별도의 camelCase alias를
두지 않는다. proto enum은 모두 `*_UNSPECIFIED = 0`을 첫 값으로 두고, 신규
선택 message/`oneof` presence 안에서만 사용한다. 필드 부재는 legacy/미사용이며
`off`, `new`, `default`로 추정하지 않는다. present인데 `UNSPECIFIED`이거나
unknown 숫자/문자열이면 `WIRE_UNSUPPORTED_ENUM`으로 거부한다.

| 개념 | domain/stdio | proto |
|---|---|---|
| grounding status | `grounded`, `no_evidence`, `uncompiled`, `unavailable` | `GROUNDED`, `NO_EVIDENCE`, `UNCOMPILED`, `UNAVAILABLE` |
| provenance | `explicit`, `inherit`, `legacy-inherit`, `default` | `EXPLICIT`, `INHERIT`, `LEGACY_INHERIT`, `DEFAULT` |
| provider session mode | `new`, `resume` | `NEW`, `RESUME` |
| provider session state | `started`, `resumed`, `closed` | `STARTED`, `RESUMED`, `CLOSED` |
| error code | 문서 §2.2의 대문자 안정 code 문자열 | `WireErrorCode`의 동일 이름 enum (`WIRE_ERROR_CODE_UNSPECIFIED = 0`) |

### 2.5 decode 실패 전달

공통 validator는 throw나 `null`이 아니라
`{ok:true,value} | {ok:false,requestId?,error:{code,field}}`를 반환한다.
오류에는 offending value를 넣지 않는다.

- 비어 있지 않은 유효 `requestId`가 correlated error의 전제다. JSON 손상,
  requestId 부재·빈 값·형식 오류는 상관 가능한 domain 요청이 아니다. stdio는
  값 미포함 diagnostic 후 무응답, gRPC는 `INVALID_ARGUMENT` transport status로
  끝내며 `AgentEvent`를 만들지 않는다.
- stdio: 알려진 `chat_request`와 유효 requestId가 있으면 invalid request를 app
  route로 전달해 동일 code의 error terminal 1회를 방출한다.
- gRPC: stream을 먼저 등록한 뒤 validator 실패 시 동일 code의 `ErrorEvent`
  1회를 쓰고 stream을 끝낸다.
- 유효 requestId가 있는 요청은 두 경로가 같은 code·단일 terminal을 쓴다.
  모든 validation/authorization 실패 뒤 retrieval/provider 호출은 0회다.
- 기존 `error.message`는 일반적인 안전 문구만 포함하고 상세 표시는 Shell i18n이
  `code`로 결정한다.

## 3. 경계 검증 규칙

- attachment 최대 개수 8, 각 `sizeBytes`는 1..20 MiB 정수.
- attachment는 `user` 메시지에만 허용하고 요청 안의 attachment id는 중복될 수
  없다. 출력 image artifact에도 같은 MIME/size/ref 검증을 적용한다.
- 전체 chat 요청은 UTF-8 직렬화 기준 2 MiB 이하이다.
- `requestId`, `sessionId`, attachment id, `localRef`, `bindingId`,
  `knowledgeScope`, `providerSessionRef`, `credentialRef`는 각각 1..128자다.
- provider는 1..64자, model은 1..256자다.
- source title과 artifact name은 각각 1..256자, URI는 1..2,048자다.
- `localRef`, `providerSessionRef`, `credentialRef`, `bindingId`는 opaque token이다.
  `/`, `\`, `:`, `..`, `data:`, base64 payload를 허용하지 않는다.
- ID/ref/scope/title/name은 제어문자를 허용하지 않는다.
- source는 최대 16개, source별 URI 최대 8개다.
- `grounded`는 source 1개 이상이어야 한다.
- `no_evidence | uncompiled | unavailable`은 source가 없어야 한다.
- source URI scheme은 `https | http | kb | naia`를 허용한다. `file`은 shell
  channel에서만 허용한다. URL credential, 제어문자, `data:`/`javascript:`,
  Discord로의 로컬 경로, `token|key|signature|auth` query key는 거부한다.
  동일 URI는 첫 항목만 보존한다.
- 모든 grounding policy는 비어 있는 `knowledgeScope`를 허용하지 않는다.
- `discord` channel은 binding과 guild/channel/user 네 값이 모두 있어야 한다.
- 신규 enum의 unknown 값은 기본값으로 바꾸지 않고 decode 실패다.
- legacy text-only 요청은 신규 검증을 발화하지 않는다.

### 3.1 stream 순서·cardinality

- grounding request 하나에는 grounding event가 정확히 0회(정책 `off`) 또는
  1회(`available|required`)다.
- `required`의 grounding event는 첫 text/artifact보다 먼저다.
- `required + grounded`만 provider의 일반 답변 text/artifact를 허용한다.
- `required + no_evidence|uncompiled|unavailable`은 일반 답변 text/artifact를
  금지한다. i18n 가능한 기권은 status와 안정 error code로 표현하고 terminal은
  정확히 1회다.
- provider session을 사용한 turn은 `started|resumed`를 첫 provider content보다
  먼저 정확히 1회 방출한다. 일반 turn terminal은 handle을 닫지 않는다.
  provider/agent가 활성 turn 중 handle을 실제로 닫는 경우에만 `closed`를
  terminal 직전 정확히 1회 방출하고 폐기한다. 만료·회전으로 이미 폐기된 handle의
  다음 resume은 session error terminal로 거부하며 가짜 `closed` event를 만들지
  않는다.
- provider session handle 기본 TTL은 마지막 성공 사용부터 24시간이다.
  credential generation 변경, provider/model 변경, workspace/session/channel
  identity 변경, 명시 close 중 하나가 발생하면 즉시 폐기한다.

## 4. 하위 호환과 unknown-field 정책

- 모든 proto field number는 새 번호만 사용하며 기존 번호를 재사용하지 않는다.
- 기존 client는 새 field/event를 무시할 수 있다.
- 새 server는 proto의 알 수 없는 field를 protobuf 규칙대로 무시한다.
- 새 enum의 알 수 없는 숫자/문자열은 domain으로 승격하지 않고 fail-closed한다.
- stdio는 신규 필드가 없으면 기존 JSON shape를 byte-shape 수준으로 유지한다.
- 오류 `message`는 당장 제거하지 않고 `code?`를 additive로 둔다.
- proto descriptor snapshot에서 기존 field number/name/type을 비교해 재사용·
  변경을 차단한다.

## 5. P02 테스트 시나리오와 요구사항 매핑

| TEST-ID | 테스트 | 요구 |
|---|---|---|
| T-WIRE-01 | 기존 text-only stdio/gRPC decode shape와 enum 부재 무회귀 | S-WIRE-01, FR-WIRE-01, NFR-WIRE-COMPAT |
| T-WIRE-02 | attachment stdio/gRPC/domain 왕복 | S-WIRE-03, FR-WIRE-02 |
| T-WIRE-03 | channel/binding/grounding stdio/gRPC/domain 왕복 | S-WIRE-04, FR-WIRE-03~04 |
| T-WIRE-04 | provider-session stdio/gRPC/ProviderChatOpts 전달, sessionId 누락·결속 불일치 거부 | S-WIRE-02, FR-WIRE-05 |
| T-WIRE-05 | grounding/source/artifact/session/error stdio encode + gRPC encode 동형 | S-WIRE-05, FR-WIRE-06~09 |
| T-WIRE-06 | Shell Rust `json_to_chat_request` 신규 입력→proto와 proto event→UI JSON 양방향 무손실 | S-WIRE-03~05, FR-WIRE-02~09 |
| T-WIRE-07 | main/sub/memory 정확히 3개·필드별 provenance proto 왕복·유일성·정렬, partial 거부 | S-WIRE-06, FR-WIRE-10 |
| T-WIRE-08 | unknown/UNSPECIFIED enum과 잘못된 MIME/크기/ref/path/snowflake/scope/sessionId 거부 | FR-WIRE-11 |
| T-WIRE-09 | 위조 scope/binding과 교차 workspace/channel/user 거부, retrieval/provider 0회 | S-WIRE-04, FR-WIRE-03~04, NFR-WIRE-SEC |
| T-WIRE-10 | bytes/base64, raw provider thread id, 비밀 credential/token, 검증되지 않은 외부 ref, 원문 지식이 wire·오류·로그에 나타나지 않음. 검증된 agent-issued opaque ref는 wire 왕복하되 오류·진단 로그에서는 값 redaction | NFR-WIRE-SEC |
| T-WIRE-11 | source/status scheme·credential·query·중복·개수·문자열 상한 검증 | FR-WIRE-07, FR-WIRE-11, NFR-WIRE-BOUND |
| T-WIRE-12 | required grounding과 provider-session event 순서/cardinality/TTL/credential·provider·session·channel 변경 폐기 | FR-WIRE-04~05, FR-WIRE-07~08 |
| T-WIRE-13 | 유효 requestId validator 실패는 stdio/gRPC 동일 code 단일 terminal·provider 0회; ID 부재는 transport별 비상관 거부 | FR-WIRE-11, NFR-WIRE-CODEC |
| T-WIRE-14 | descriptor snapshot으로 기존 proto field number/name/type 불변 확인 | NFR-WIRE-COMPAT |
| T-WIRE-15 | Shell i18n key가 모든 안정 error code를 망라하고 wire에 표시문구 없음 | FR-WIRE-09, NFR-WIRE-I18N |
| T-WIRE-16 | 2 MiB 요청·collection/string 상한 경계값과 초과값 | NFR-WIRE-BOUND |
| T-WIRE-17 | agent TypeScript build + Shell TypeScript/Rust paired-proto build | FR-WIRE-12, NFR-WIRE-BUILD |
| T-WIRE-18 | 양방향 codec fixture round-trip과 unknown-field 허용 | NFR-WIRE-CODEC, NFR-WIRE-COMPAT |

## 6. P03 FR/NFR

| ID | 요구사항 | 초기 상태 |
|---|---|---|
| FR-WIRE-01 | 신규 필드가 없는 기존 text-only stdio/gRPC 요청은 기존 domain shape와 동작을 유지한다. | Implemented |
| FR-WIRE-02 | 메시지는 안전한 이미지 `AttachmentRef[]`를 선택적으로 운반한다. | Implemented |
| FR-WIRE-03 | 요청은 shell/Discord binding·guild·channel·user 격리를 구조화 `ChannelContext`로 운반하고 trusted binding 불일치를 provider 전에 거부한다. | Implemented |
| FR-WIRE-04 | 요청은 grounding 정책과 knowledge scope claim을 구조적으로 운반하고 workspace/channel 허용 scope와 대조한다. | Implemented |
| FR-WIRE-05 | 요청은 provider session `new/resume` 의미를 provider 호출 옵션까지 전달할 수 있다. | Implemented |
| FR-WIRE-06 | 출력은 이미지 artifact를 stdio/gRPC/Shell까지 무손실 운반한다. | Implemented |
| FR-WIRE-07 | 출력은 grounding status와 bounded source URI를 무손실 운반한다. | Implemented |
| FR-WIRE-08 | 출력은 opaque provider session lifecycle을 무손실 운반한다. | Implemented |
| FR-WIRE-09 | 기존 문자열 오류에 안정 code를 additive로 붙여 클라이언트가 분기할 수 있다. | Implemented |
| FR-WIRE-10 | `main/sub/memory` 유효 설정과 provider/model/credential 필드별 provenance를 같은 proto 계약으로 표현한다. | Implemented |
| FR-WIRE-11 | 신규 unknown/UNSPECIFIED enum과 attachment/channel/grounding/ref 불변식 위반은 stdio/gRPC 동일 code 단일 terminal로 fail-closed한다. | Implemented |
| FR-WIRE-12 | agent proto SoT와 Shell Rust 소비 코드는 같은 #89 commit pair 기준으로 컴파일된다. | Implemented |

- **NFR-WIRE-SEC**: bytes/base64, raw provider thread id, 비밀 credential/token,
  검증되지 않은 외부 ref, 원문 지식은 wire·codec 오류·fixture·진단 로그에
  들어가지 않는다. 검증된 agent-issued opaque ref는 wire에서 왕복하지만
  오류·진단 로그에는 실제 값을 남기지 않는다.
- **NFR-WIRE-BOUND**: 모든 신규 collection/string/size는 상한이 있고 decode
  비용이 입력 크기에 선형이다.
- **NFR-WIRE-CODEC**: stdio와 gRPC는 하나의 domain validator를 공유하고
  서로 다른 관대한 fallback을 만들지 않는다.
- **NFR-WIRE-COMPAT**: 기존 proto 번호와 JSON 필드는 바꾸거나 재사용하지 않는다.
- **NFR-WIRE-I18N**: wire는 안정 code만 소유하고 사용자 표시 문구를 소유하지 않는다.
- **NFR-WIRE-BUILD**: agent TypeScript와 Shell TypeScript/Rust 생성 코드가
  모두 빌드돼야 계약을 동결할 수 있다.

## 7. 구현 순서

1. 본 계약과 정본 P01/P03 인덱스를 계획 리뷰로 수렴한다.
2. agent stdio/gRPC와 Shell TS/Rust에 RED 계약 테스트를 먼저 추가한다.
3. 공통 domain validator와 additive 타입을 구현한다.
4. stdio codec, gRPC proto/codec/server rejection, Shell 변환 순으로 GREEN을
   만든다.
5. handler에는 provider session option과 stream ordering seam만 연결한다.
6. Shell `build.rs`는 `NAIA_AGENT_PROTO_DIR` 명시 경로를 우선하고 proto가
   없으면 warning이 아니라 실패한다. paired build는 Session 1 agent worktree의
   proto와 descriptor hash를 명시한다.
7. planning·development·test·integration review를 각각 수렴하고, 양방향
   round-trip·관련 전체 테스트·build·guardian PASS 뒤 독립 재검증을 두 번 한다.
8. agent/shell 로컬 coordination commit을 만들고 SHA·변경 파일·검증 결과를
   GitHub #89 댓글과 루트 handoff 작업영역
   `.agents/work/jeonju-naia-workshop-2026-07-28/CONTRACT-FROZEN-v1.md`에
   동일하게 기록한다. 이 marker는 agent/shell repo 문서가 아니므로 두 repo의
   Doc Registry/F13 대상에 새 경로로 추가하지 않는다.
9. 그 뒤에만 `[CONTRACT FROZEN v1] naia-agent#89`를 선언한다.

## 8. 비범위

- Codex SDK/app-server adapter
- Discord Gateway와 실제 봇 설치
- RAG 검색·ingest 구현
- 이미지 picker/저장소/렌더 UI
- 역할별 provider 해석·상속 runtime
- 기존 문자열 오류의 일괄 치환
- 실제 외부 서버·credential을 사용하는 E2E

## 9. 보안 처리 위치 확장 — Session 1/2 협의 v2

클라우드 처리를 일괄 금지하지 않으며 embedding도 같은 처리 위치 공개 대상이다.
선택된 profile 밖으로 장애나 VRAM 부족만을 이유로 몰래 전환하지 않는다.

### 9.1 입력과 출력

- `ChatRequest.processing?: { processingProfileRef: string }`
- protobuf `ChatRequest.processing = 14`
- `TrustedBinding.processingProfileRef`
- `AgentEmit.processingDisclosure`
- protobuf `AgentEvent.processing_disclosure = 20`

처리 위치는 `local_device | private_managed | external_cloud`, 처리 종류는
`main_llm | sub_llm | memory_llm | embedding | network_tool`, 판단은
`allowed | blocked | confirmation_required`의 폐쇄 enum이다. 실제 endpoint,
URL, host, prompt, message, memory 원문, secret, credential 해석값은 event에
싣지 않는다.

Discord의 profile reference는 message나 모델 출력이 아닌 신뢰된 binding과
정확히 일치해야 한다. 신규 Discord 요청에서 reference가 없으면
`PROCESSING_PROFILE_REQUIRED`, binding 부재나 불일치는 `WIRE_SCOPE_FORBIDDEN`으로
downstream 전에 차단한다.

### 9.2 검증과 순서

- disclosure event는 폐쇄 필드 집합과 길이·enum·opaque ref를 검증한다.
- 실제 operation은 같은 request stream에서 disclosure를 먼저 방출하고
  `allowed` 뒤에만 downstream을 호출한다.
- `blocked | confirmation_required` 뒤에는 안정 error를 방출하고 downstream은
  호출하지 않는다.
- 외부 처리 확인은 wire 밖 신뢰 저장소의 일회성 기록이며 opaque
  `consentId`와 `{processingProfileRef,destination,workload,sessionId,
  expiresAt,consumedAt}`에 결속한다. 만료시각과 현재시각이 같아도 만료다.

추가 안정 오류 번호:

- 21 `PROCESSING_PROFILE_REQUIRED`
- 22 `PROCESSING_DESTINATION_UNKNOWN`
- 23 `EXTERNAL_PROCESSING_FORBIDDEN`
- 24 `EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED`

### 9.3 추가 테스트

| TEST-ID | 테스트 | 요구 |
|---|---|---|
| T-WIRE-19 | processing field 14와 disclosure event 20의 stdio/gRPC/Rust 왕복 | FR-WIRE-13~14 |
| T-WIRE-20 | Discord profile 부재·binding 부재·불일치 fail-closed | FR-WIRE-13 |
| T-WIRE-21 | disclosure 폐쇄 필드·enum·길이·ref 검증과 값 미반향 | FR-WIRE-14 |
| T-WIRE-22 | disclosure → downstream/error 순서의 순수 계획 seam | FR-WIRE-15 |
| T-WIRE-23 | consent 만료·재사용·scope 불일치 반증 | FR-WIRE-16 |

## 10. 동결 후보 검증 결과

- Agent 전체: 1,191 PASS, 8 live skip, 실패 0
- Shell UI/package 전체: 1,253 PASS, 13 skip, 실패 0
- Agent/Shell TypeScript build: PASS
- paired Agent proto를 지정한 Shell Rust wire 검증: PASS
- Agent file anchors 91/91, compile integrity, logging, CI structure,
  conflict marker, `git diff --check`: PASS
- 계약 감시자: 코드 PASS
- 구현에 참여하지 않은 독립 리뷰어: 실행/보안 및 역추적/호환성 두 패스 연속 CLEAN

라이브 제외는 실제 외부 provider, 원격 embedding·memory LLM, Qdrant,
Discord bot/credential, 실제 네트워크 E2E다. 이 항목은 계약 구현 PASS로
위장하지 않으며 Session 2의 동결 후 통합 및 credential gate에서 계속 추적한다.
