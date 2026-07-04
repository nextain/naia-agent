/**
 * Human-like memory bench — hand-authored multi-session scenarios (v1 MVP).
 *
 * Slice 1 ships ONE preference-application scenario. Preference is more
 * objective than emotion-association (the signal is cleaner), so per the
 * flagship cross-review it is authored first. Each scenario carries a
 * POSITIVE probe (recall SHOULD surface) and a NEGATIVE/control probe (recall
 * would be socially wrong) — without the negative control the bench rewards a
 * "creepy database" that drags old memories up constantly, the opposite of
 * human-like (Claude + GPT-5.5 consensus, 2026-07-04).
 *
 * Anchor strings in `expectedMemorySet` / `forbiddenRecalls` are short lexical
 * cues, NOT exact phrases — containment is judged by the injected Korean-aware
 * predicate. Emotion-association scenarios + a 2nd preference scenario arrive
 * in Slice 3.
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

export const HUMANLIKE_SCENARIOS: readonly HumanlikeScenario[] = [PREF_VEGETARIAN];
