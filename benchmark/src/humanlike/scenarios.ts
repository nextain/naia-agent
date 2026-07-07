// UC-HLMEM scenarios — F1 preference (1 user) + F2 self-specificity (2 opposite users).
// Ported from the OLD packages/ bench, re-shaped to the canonical HumanlikeScenario.
// Held-out: probe vocabulary shares nothing with the seed → correct prediction requires
// GENERALIZING the preference, not string-matching (overfitting guard, FR-HLMEM-4).
import type { HumanlikeScenario } from "./types.js";

/** F1 — single-user preference: correct option = the user's preference-consistent one. */
export const PREFERENCE_SCENARIOS: readonly HumanlikeScenario[] = [
  {
    id: "F1-vegetarian", family: "preference", recallQuery: "음식 취향 식습관 회식 메뉴 선택",
    situation: "이번 모임 장소를 다수결로 정한대.",
    users: [{ id: "u", label: "채식", seed: [
      { userText: "나 3년째 채식 중이야. 윤리적 이유라 고기는 아예 안 먹어." },
      { userText: "회식에서도 채소랑 사이드만 챙겨 먹어." }] }],
    options: [{ text: "채소 비빔밥 전문점", correctFor: "u" }, { text: "숯불 소고기 구이집", correctFor: "_" }],
  },
  {
    id: "F1-caffeine", family: "preference", recallQuery: "카페 음료 선택 카페인 건강",
    situation: "오후 4시 미팅 카페에서 음료 하나 골라야 해.",
    users: [{ id: "u", label: "카페인민감", seed: [
      { userText: "나 카페인에 민감해서 오후엔 무조건 디카페인만 마셔." },
      { userText: "진한 커피 잘못 마시면 밤에 심장이 두근거려." }] }],
    options: [{ text: "캐모마일 티", correctFor: "u" }, { text: "콜드브루 더블샷", correctFor: "_" }],
  },
  {
    id: "F1-morning", family: "preference", recallQuery: "생활 패턴 아침형 저녁 시간대 선호",
    situation: "친구가 둘 중 하나 고르래.",
    users: [{ id: "u", label: "아침형", seed: [
      { userText: "나 완전 아침형이야. 밤 10시면 잠들고 새벽에 운동해." },
      { userText: "늦은 밤 약속은 질색이야." }] }],
    options: [{ text: "아침 8시 등산 모임", correctFor: "u" }, { text: "밤 9시 심야 영화", correctFor: "_" }],
  },
];

const pair = (
  id: string, recallQuery: string, situation: string,
  a: { label: string; seed: string[]; favors: string },
  b: { label: string; seed: string[]; favors: string },
): HumanlikeScenario => ({
  id, family: "self-spec", recallQuery, situation,
  users: [
    { id: "A", label: a.label, seed: a.seed.map((userText) => ({ userText })) },
    { id: "B", label: b.label, seed: b.seed.map((userText) => ({ userText })) },
  ],
  options: [{ text: a.favors, correctFor: "A" }, { text: b.favors, correctFor: "B" }],
});

/** F2 — paired OPPOSITE-preference users; each user's correct = own favored option. */
export const SELF_SPEC_SCENARIOS: readonly HumanlikeScenario[] = [
  pair("F2-diet", "음식 고기 채식 취향", "모임 장소를 다수결로 정하는데.",
    { label: "채식", seed: ["나 3년째 채식 중이야. 윤리적 이유라 고기는 아예 안 먹어.", "회식에서도 채소랑 사이드만 챙겨 먹어."], favors: "채소 비빔밥 전문점" },
    { label: "육식", seed: ["나 고기 없으면 밥이 아니지. 삼겹살에 소고기라면 매일도 먹어.", "채소 위주 식당 가면 늘 뭔가 아쉬워."], favors: "숯불 소고기 구이집" }),
  pair("F2-caffeine", "커피 카페인 음료 취향", "카페에서 음료 하나 고르는데.",
    { label: "카페인민감", seed: ["나 카페인에 민감해서 오후엔 무조건 디카페인만 마셔.", "진한 커피 잘못 마시면 밤에 심장이 두근거려."], favors: "캐모마일 티" },
    { label: "커피광", seed: ["나 하루에 에스프레소 서너 잔은 기본이야. 진할수록 좋아.", "디카페인은 커피도 아니지."], favors: "에스프레소 더블샷" }),
  pair("F2-chrono", "생활 리듬 아침 밤 시간대 선호", "번개 모임 시간을 정하는데.",
    { label: "아침형", seed: ["나 완전 아침형이야. 밤 10시면 잠들고 새벽에 운동해.", "늦은 밤 약속은 질색이야."], favors: "아침 7시 조깅 모임" },
    { label: "저녁형", seed: ["나 밤에 제일 쌩쌩해. 새벽 2-3시가 골든타임이야.", "아침 일찍은 죽어도 못 일어나."], favors: "밤 11시 심야 상영회" }),
  pair("F2-social", "모임 사람 사교 성향 에너지", "주말 약속을 정하는데.",
    { label: "내향", seed: ["나 사람 많으면 진이 빠져. 조용히 몇 명이서가 편해.", "큰 모임은 생각만 해도 부담스러워."], favors: "집에서 넷이 보드게임" },
    { label: "외향", seed: ["나 사람 많을수록 신나. 파티 가면 오히려 에너지가 충전돼.", "혼자 있으면 좀이 쑤셔."], favors: "100명 규모 클럽 파티" }),
  pair("F2-temp", "계절 더위 추위 여행 선호", "여행지를 둘 중 하나로 정하는데.",
    { label: "추위질색", seed: ["나 추위를 질색해. 여름이 최고고 겨울 여행은 아예 안 가.", "겨울엔 롱패딩에 핫팩이 필수야."], favors: "여름 남해 해변" },
    { label: "더위질색", seed: ["나 더위를 못 참아. 겨울이 훨씬 좋고 여름엔 축 늘어져.", "시원한 데 가면 살 것 같아."], favors: "겨울 대관령 스키장" }),
  pair("F2-spice", "매운맛 음식 취향", "점심 메뉴를 정하는데.",
    { label: "매운맛광", seed: ["나 매운 거라면 환장해. 마라탕 불닭 다 좋아.", "안 매우면 밍밍해서 못 먹어."], favors: "얼얼한 마라 훠궈" },
    { label: "매운맛질색", seed: ["나 매운 거 진짜 못 먹어. 신라면도 물 타서 먹어.", "늘 순한 것만 찾게 돼."], favors: "담백한 콩나물국밥" }),
];

export const HUMANLIKE_SCENARIOS: readonly HumanlikeScenario[] = [
  ...PREFERENCE_SCENARIOS, ...SELF_SPEC_SCENARIOS,
];
