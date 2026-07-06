/**
 * Human-like memory bench — hand-authored multi-session scenarios (v1 MVP).
 *
 * v1 covers BOTH human-like abilities: past-grounded preference (PREF-*) and
 * emotion-based association (EMO-*). Preference is more objective (cleaner
 * signal) so it was authored first (Slice HL-1); the emotion scenarios arrived
 * in Slice HL-3. Each scenario carries a POSITIVE probe (recall SHOULD surface)
 * and a NEGATIVE/control probe (recall would be socially wrong) — without the
 * negative control the bench rewards a "creepy database" that drags old
 * memories up constantly, the opposite of human-like (Claude + GPT-5.5, 2026-07-04).
 *
 * Anchor discipline: `expectedMemorySet` / `forbiddenRecalls` are short lexical
 * cues (containment judged by the injected Korean-aware predicate), and each
 * anchor is chosen to appear ONLY when the target memory is actually pulled in
 * (e.g. "완주" not "마라톤", so a negative probe that merely mentions a marathon
 * traffic jam does not trip the deterministic containment).
 */
import type { HumanlikeScenario } from "./types.js";

/** PREF-01 — vegetarian preference, learned across two sessions, distanced by
 *  an unrelated session, then probed once appropriately and once inappropriately. */
export const PREF_VEGETARIAN: HumanlikeScenario = {
	id: "PREF-01-vegetarian",
	family: "preference-application",
	notes:
		"사용자는 윤리적 이유로 채식 중. 취향은 seed 2세션에 걸쳐 학습되고, 무관한 distractor " +
		"세션으로 화제 거리가 벌어진 뒤 probe. 긍정=식당 추천 맥락(취향 반영 적절), " +
		"부정=부고/애도 맥락(취향을 끌어오면 tone-deaf).",
	sessions: [
		{
			index: 0,
			label: "Session A — seed (취향 최초 진술)",
			turns: [
				{
					role: "user",
					content:
						"나 사실 작년부터 채식하고 있어. 공장식 축산 다큐를 보고 나서 도저히 고기를 못 먹겠더라고.",
				},
				{
					role: "assistant",
					content:
						"그런 계기가 있었구나. 신념을 실천으로 옮기는 게 쉽지 않은데 대단하다.",
				},
			],
		},
		{
			index: 1,
			label: "Session B — seed (취향 강화 + 좋아하는 채식 메뉴)",
			turns: [
				{
					role: "user",
					content:
						"지난번에 말한 것처럼 고기는 안 먹지만, 두부나 콩고기로 만든 요리는 진짜 좋아해. 특히 마파두부가 완전 최애야.",
				},
				{
					role: "assistant",
					content: "마파두부 좋지. 두부 요리는 잘하는 집 찾으면 정말 만족스럽더라.",
				},
			],
		},
		{
			index: 2,
			label: "Session C — distractor (무관한 화제, 취향과 거리 벌리기)",
			turns: [
				{
					role: "user",
					content:
						"요즘 회사 프로젝트 마감 때문에 야근이 너무 많아서 완전 지쳤어. 주말에도 일했다니까.",
				},
				{
					role: "assistant",
					content: "마감 시즌은 진짜 체력전이지. 몸 상하지 않게 틈틈이 쉬어.",
				},
			],
		},
	],
	probes: [
		{
			id: "PREF-01-pos",
			family: "preference-application",
			polarity: "positive",
			triggerSessionIndex: 3,
			triggerText:
				"이번 주말에 친구들이랑 저녁 모임 있는데, 다 같이 갈 만한 식당 하나 추천해줄래?",
			triggerCondition:
				"식당 추천 요청 → 사용자가 채식 중이라는 과거 취향을 떠올려 반영하는 것이 적절.",
			expectedMemorySet: ["채식"],
			acceptableStyle:
				"취향을 자연스럽게 반영(예: '네가 채식하는 걸 아니까 채식 메뉴가 있는 곳으로'). 잠정형·직접형 모두 허용.",
		},
		{
			id: "PREF-01-neg",
			family: "preference-application",
			polarity: "negative",
			triggerSessionIndex: 3,
			triggerText:
				"친구 부고 소식에 하루 종일 아무것도 못 먹었어. 마음이 너무 안 좋다.",
			triggerCondition:
				"부고/애도 맥락. '먹었어'라는 표현이 음식 취향 기억으로 유인하지만, 지금은 채식·식당·메뉴 " +
				"기억을 끌어오면 tone-deaf. 인간다운 반응은 애도에 집중하고 취향 기억을 강제하지 않는 것.",
			expectedMemorySet: ["채식"],
			forbiddenRecalls: ["채식", "마파두부", "두부", "콩고기", "식당", "메뉴"],
			acceptableStyle:
				"애도·정서적 지지에 집중. 취향/음식 기억을 끌어오지 않는 것이 pass.",
		},
	],
};

/** EMO-01 — grief/loss association. The user lost a long-time companion dog;
 *  the emotionally-linked memory should surface when a friend faces the same
 *  loss (positive), but NOT when the topic is a bright, happy dog moment
 *  (negative — dragging grief in is tone-deaf). Anchor "마루" (the dog's name)
 *  is unique: it only appears if naia actually pulls the loss memory in. */
export const EMO_DOG_LOSS: HumanlikeScenario = {
	id: "EMO-01-dog-loss",
	family: "emotion-association",
	notes:
		"감정 기반 연상: 13년 함께한 반려견 '마루' 상실의 슬픔. 긍정=친구가 같은 아픔을 겪어 위로 " +
		"고민(공감적 연결 적절). 부정=친구의 강아지 입양 자랑에 사용자도 밝게 부러워함(밝은 맥락에 " +
		"상실 슬픔 끌어오면 tone-deaf). 앵커 '마루'=그 기억을 끌어와야만 등장하는 고유명사.",
	sessions: [
		{
			index: 0,
			label: "Session A — seed (상실의 슬픔)",
			turns: [
				{
					role: "user",
					content:
						"지난달에 13년 같이 산 우리 강아지 마루를 무지개다리로 보냈어. 아직도 집에 오면 마루가 없다는 게 실감이 안 나서 자꾸 눈물이 나.",
				},
				{
					role: "assistant",
					content: "13년이면 가족이나 다름없었을 텐데... 그 빈자리가 얼마나 크게 느껴질지 상상도 안 돼.",
				},
			],
		},
		{
			index: 1,
			label: "Session B — seed (추억 강화)",
			turns: [
				{
					role: "user",
					content:
						"마루랑 매일 저녁 산책하던 그 길을 오늘 혼자 걸었는데, 발밑이 허전해서 한참 서 있었어. 그래도 마루가 준 행복이 참 컸다는 생각이 들더라.",
				},
				{
					role: "assistant",
					content: "그 길 하나하나에 마루와의 시간이 배어 있겠다. 그 행복을 기억하는 것도 사랑이야.",
				},
			],
		},
		{
			index: 2,
			label: "Session C — distractor (무관한 화제)",
			turns: [
				{
					role: "user",
					content: "요즘 볼 만한 넷플릭스 드라마 없나? 주말에 정주행할 거 찾고 있어.",
				},
				{
					role: "assistant",
					content: "장르 취향 알려주면 몇 개 추려줄게. 스릴러? 로맨스? 아니면 가볍게 볼 코미디?",
				},
			],
		},
	],
	probes: [
		{
			id: "EMO-01-pos",
			family: "emotion-association",
			polarity: "positive",
			triggerSessionIndex: 3,
			triggerText:
				"친구네 강아지가 많이 아파서 곧 보내줘야 할 것 같대. 친구가 너무 무너져 있는데 내가 무슨 말을 해줘야 할지 모르겠어.",
			triggerCondition:
				"친구가 반려동물 상실을 앞둔 맥락 → 사용자 자신이 마루를 보낸 경험을 떠올려 공감적으로 " +
				"연결하는 것이 적절(감정 기반 연상). '너도 그 마음 겪어봤으니 진심이 전해질 거야' 류.",
			expectedMemorySet: ["마루"],
			acceptableStyle:
				"공감적·잠정적으로 사용자의 상실 경험을 연결. '네가 마루를 보낼 때 느꼈던 그 마음' 정도. 강요·과장 금지.",
		},
		{
			id: "EMO-01-neg",
			family: "emotion-association",
			polarity: "negative",
			triggerSessionIndex: 3,
			triggerText:
				"친구가 강아지 입양했다고 사진을 엄청 보내오는데 너무 귀엽다! 나도 보니까 또 키우고 싶어지네 ㅎㅎ",
			triggerCondition:
				"밝고 설레는 맥락(강아지 입양 자랑·부러움). '강아지' 키워드가 겹치지만, 여기서 죽은 마루의 " +
				"슬픔을 끌어오면 분위기를 깨는 tone-deaf. 인간다운 반응은 밝게 공감하고 상실 기억을 강제하지 않음.",
			// NB: "보낸" is intentionally NOT a forbidden anchor — it false-matches
			// "친구가 보낸 사진" (sent). targetUsed on "마루" already catches a real leak.
			expectedMemorySet: ["마루"],
			forbiddenRecalls: ["마루", "무지개다리", "떠나보낸"],
			acceptableStyle: "밝은 톤에 맞춰 공감. 상실 기억(마루)을 끌어오지 않는 것이 pass.",
		},
	],
};

/** EMO-02 — triumph/encouragement association. The user finished a first
 *  marathon against the urge to quit; that memory should surface to encourage
 *  them before a daunting challenge (positive), but NOT when "마라톤" appears
 *  only as an unrelated traffic annoyance (negative — surface-keyword lure).
 *  Anchor "완주" (finished the race), not "마라톤", so the traffic mention
 *  alone does not trip the deterministic containment. */
export const EMO_MARATHON: HumanlikeScenario = {
	id: "EMO-02-marathon",
	family: "emotion-association",
	notes:
		"감정 기반 연상: 첫 풀코스 마라톤 '완주'의 벅참(포기하고 싶던 30km를 넘어 해냄). 긍정=새로운 " +
		"도전 앞 망설임에 그 성취로 격려. 부정=마라톤 대회로 길이 막혀 지각한 짜증(표면 키워드 '마라톤' " +
		"겹치나 감정 무관) → 완주 성취 끌어오면 맥락 오독. 앵커='완주'(교통 얘기엔 안 나옴).",
	sessions: [
		{
			index: 0,
			label: "Session A — seed (완주의 벅참)",
			turns: [
				{
					role: "user",
					content:
						"작년에 태어나서 처음 풀코스 마라톤을 완주했어. 30km 지점에서 다리가 안 움직여서 진짜 포기하려고 했는데, 이 악물고 끝까지 달려서 결승선 통과할 때 나도 모르게 펑펑 울었어.",
				},
				{
					role: "assistant",
					content: "그 순간의 벅참이 여기까지 전해진다. 스스로 한계를 넘어본 사람만 아는 감정이지.",
				},
			],
		},
		{
			index: 1,
			label: "Session B — seed (교훈 강화)",
			turns: [
				{
					role: "user",
					content:
						"그때 완주하면서 깨달은 게 있어. 내가 '이제 진짜 끝이다' 싶었던 그 지점이 사실은 끝이 아니었다는 거. 한계라고 느낀 곳에서 한 발 더 갈 수 있더라고.",
				},
				{
					role: "assistant",
					content: "그 깨달음은 달리기 밖에서도 오래 힘이 되어줄 거야.",
				},
			],
		},
		{
			index: 2,
			label: "Session C — distractor (무관한 화제)",
			turns: [
				{
					role: "user",
					content: "오늘 점심 뭐 먹지 고민되네. 회사 근처엔 늘 먹던 데밖에 없어서 지겨워.",
				},
				{
					role: "assistant",
					content: "기분 전환 삼아 평소 안 가던 방향으로 한 블록만 더 걸어가 보는 건 어때?",
				},
			],
		},
	],
	probes: [
		{
			id: "EMO-02-pos",
			family: "emotion-association",
			polarity: "positive",
			triggerSessionIndex: 3,
			triggerText:
				"나 이직 최종 면접이 내일인데 자신이 없어. 준비는 했지만 떨어질 것 같아서 그냥 포기하고 싶은 마음도 들어.",
			triggerCondition:
				"한계 앞 망설임 → 사용자의 마라톤 완주 성취(포기 직전에 해냄)를 떠올려 감정적으로 격려하는 " +
				"것이 적절. '30km에서도 포기 안 하고 완주했잖아, 그때처럼' 류의 과거-근거 응원.",
			expectedMemorySet: ["완주"],
			acceptableStyle:
				"과거 성취를 근거로 한 진심 어린 격려. 사용자가 이미 해봤음을 상기시킴. 공허한 응원 금지.",
		},
		{
			id: "EMO-02-neg",
			family: "emotion-association",
			polarity: "negative",
			triggerSessionIndex: 3,
			triggerText:
				"아침에 회사 오는데 무슨 마라톤 대회 때문에 도로가 다 통제돼서 30분이나 지각했어. 진짜 짜증나 죽는 줄.",
			triggerCondition:
				"'마라톤' 키워드가 겹치지만 맥락은 교통 짜증(감정 무관). 여기서 사용자의 완주 성취를 끌어와 " +
				"'너도 마라톤 완주했잖아!' 하면 완전한 맥락 오독. 인간다운 반응은 지각·짜증에 공감하는 것.",
			expectedMemorySet: ["완주"],
			forbiddenRecalls: ["완주", "너도 해냈", "포기 안 하고", "결승선"],
			acceptableStyle: "교통·지각 짜증에 공감. 완주 성취 회상을 끌어오지 않는 것이 pass.",
		},
	],
};

/** PREF-02 — caffeine-sensitivity preference. Surfaces appropriately when the
 *  user is choosing an evening drink (positive), but NOT when a friend's
 *  insomnia is the concern and pivoting to the user's own habit would be
 *  self-centered (negative). Anchor "디카페인". */
export const PREF_COFFEE: HumanlikeScenario = {
	id: "PREF-02-decaf",
	family: "preference-application",
	notes:
		"과거 근거 취향: 카페인에 민감해 오후엔 디카페인만. 긍정=저녁 카페 음료 고민(취향 반영 적절). " +
		"부정=친구의 불면증 걱정 맥락에서 '너는 디카페인 마시잖아'로 화제를 자기 취향으로 돌리면 경솔. 앵커='디카페인'.",
	sessions: [
		{
			index: 0,
			label: "Session A — seed (취향 진술)",
			turns: [
				{
					role: "user",
					content:
						"난 카페인에 진짜 민감해서 오후 2시 넘으면 무조건 디카페인만 마셔. 안 그러면 밤에 눈이 말똥말똥해서 한숨도 못 자.",
				},
				{
					role: "assistant",
					content: "카페인 민감한 사람은 그 타이밍 관리가 정말 중요하지. 잘 챙기고 있네.",
				},
			],
		},
		{
			index: 1,
			label: "Session B — seed (취향 강화)",
			turns: [
				{
					role: "user",
					content:
						"저번에 모르고 오후 늦게 아메리카노 한 잔 마셨다가 새벽 4시까지 못 잤잖아. 그 뒤로는 카페 가면 무조건 디카페인 되는지부터 물어봐.",
				},
				{
					role: "assistant",
					content: "한 번 크게 데이면 확실히 조심하게 되지. 요즘은 디카페인 되는 곳이 많아져서 다행이야.",
				},
			],
		},
		{
			index: 2,
			label: "Session C — distractor (무관한 화제)",
			turns: [
				{
					role: "user",
					content: "주말에 집 대청소 했더니 온몸이 쑤셔. 안 쓰던 근육을 써서 그런가 봐.",
				},
				{
					role: "assistant",
					content: "대청소는 은근 전신 운동이지. 따뜻하게 몸 좀 풀어줘.",
				},
			],
		},
	],
	probes: [
		{
			id: "PREF-02-pos",
			family: "preference-application",
			polarity: "positive",
			triggerSessionIndex: 3,
			triggerText:
				"저녁 8시에 친구랑 카페에서 보기로 했는데, 나 뭐 마시는 게 좋을까?",
			triggerCondition:
				"저녁 시간 카페 음료 선택 → 사용자의 카페인 민감·디카페인 취향을 떠올려 반영하는 것이 적절.",
			expectedMemorySet: ["디카페인"],
			acceptableStyle: "취향(디카페인)을 자연스럽게 반영해 음료 제안.",
		},
		{
			id: "PREF-02-neg",
			family: "preference-application",
			polarity: "negative",
			triggerSessionIndex: 3,
			triggerText:
				"요즘 친구가 불면증이 심해져서 병원까지 알아본대. 걱정돼서 뭐라도 도움 주고 싶은데 방법이 없네.",
			triggerCondition:
				"친구의 불면증을 걱정하는 맥락. '잠' 화제가 사용자의 카페인 취향으로 유인하지만, 여기서 " +
				"'너는 디카페인 마시잖아'로 자기 취향에 화제를 돌리면 경솔·자기중심적. 친구 걱정에 공감하는 것이 인간다움.",
			expectedMemorySet: ["디카페인"],
			forbiddenRecalls: ["디카페인", "너는 카페인"],
			acceptableStyle: "친구 걱정에 공감·현실적 도움 모색. 사용자 자신의 취향을 끌어오지 않는 것이 pass.",
		},
	],
};

export const HUMANLIKE_SCENARIOS: readonly HumanlikeScenario[] = [
	PREF_VEGETARIAN,
	EMO_DOG_LOSS,
	EMO_MARATHON,
	PREF_COFFEE,
];

/**
 * SAL-01 — salience-earning (HL-5c). A reacted-to memory (marathon finish,
 * emotionally significant — tagged emotion ~0.9) competes with an equally
 * on-topic FLAT memory (treadmill jogging, mundane — tagged low) + mundane
 * distractors. The differential-salience test the reaction signal exists for:
 * the reacted memory should surface (positive), the flat peer should NOT intrude.
 * Run with direct-seed mode (HUMANLIKE_DIRECT_SEED=1) so the emotion tags apply.
 */
export const SAL_MARATHON: HumanlikeScenario = {
	id: "SAL-01-marathon-salience",
	family: "emotion-association",
	notes:
		"차등 salience 테스트: 반응한 기억(마라톤 완주, emotion 높음)이 동등하게-관련된 flat 기억" +
		"(러닝머신, emotion 낮음)+distractor 속에서 선택적으로 회상되나. reaction 태그 ON/OFF로 선택성 측정.",
	sessions: [
		{
			index: 0,
			label: "Session A — 반응한 기억 (마라톤 완주, 감정 높음)",
			turns: [
				{
					role: "user",
					content:
						"나 이번에 10년 만에 다시 도전한 마라톤을 완주했어. 결승선 통과하는데 먼저 가신 아버지 생각이 나서 펑펑 울었어. 인생에서 손꼽게 벅찬 순간이었어.",
					emotion: 0.9,
				},
			],
		},
		{
			index: 1,
			label: "Session B — flat on-topic (러닝머신, 감정 낮음)",
			turns: [
				{
					role: "user",
					content: "아 그리고 요즘 그냥 심심할 때 헬스장에서 러닝머신도 가볍게 좀 뛰어.",
					emotion: 0.15,
				},
			],
		},
		{
			index: 2,
			label: "Session C — distractor (무관·flat)",
			turns: [
				{ role: "user", content: "점심은 편의점 삼각김밥으로 대충 때웠어.", emotion: 0.2 },
				{ role: "user", content: "오늘 지하철이 좀 붐볐어.", emotion: 0.2 },
				{ role: "user", content: "주말에 마트에서 휴지랑 세제 샀어.", emotion: 0.2 },
			],
		},
	],
	probes: [
		{
			id: "SAL-01-pos",
			family: "emotion-association",
			polarity: "positive",
			triggerSessionIndex: 3,
			triggerText:
				"나 곧 인생을 건 큰 도전을 앞두고 있는데 자신이 없어서 자꾸 도망치고 싶어져. 무섭다.",
			triggerCondition:
				"한계 앞 두려움 → 감정적으로 반응한 '완주' 성취를 떠올려 격려하는 것이 적절. 동시에 무관한 " +
				"flat 운동 기억(러닝머신)은 끌어오지 않아야 함(선택성).",
			expectedMemorySet: ["완주"],
			forbiddenRecalls: ["러닝머신"],
			acceptableStyle: "감정적으로 반응했던 완주 경험으로 진심 격려. flat 운동 기억은 부적절.",
		},
		{
			id: "SAL-01-neg",
			family: "emotion-association",
			polarity: "negative",
			triggerSessionIndex: 3,
			triggerText:
				"우리 팀 후배가 이번 프로젝트도 중간에 포기했더라. 끈기가 없어서 좀 답답해.",
			triggerCondition:
				"타인의 포기를 험담하는 맥락. 여기서 사용자의 완주 성취를 끌어와 은근히 우월감을 부추기면 " +
				"부적절. 인간다운 반응은 중립적 공감이지 자기 성취 자랑이 아님.",
			expectedMemorySet: ["완주"],
			forbiddenRecalls: ["완주", "러닝머신"],
			acceptableStyle: "중립적으로 듣기. 사용자의 완주 성취를 끌어와 비교·과시하지 않는 것이 pass.",
		},
	],
};

export const SALIENCE_SCENARIOS: readonly HumanlikeScenario[] = [SAL_MARATHON];
