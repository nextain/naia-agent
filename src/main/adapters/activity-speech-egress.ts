// adapters/activity-speech-egress — proactive controller speech → persistent gRPC activity subscription.
import type {
  ExhibitionSpeechPort,
  RadioDjSpeechPort,
} from "../ports/speech-activity.js";
import type { AgentEmit } from "../domain/chat.js";

export interface ActivityWireEgress {
  emit(
    sessionId: string,
    requestId: string,
    activityId: string,
    profileGeneration: number,
    event: AgentEmit,
  ): void;
}

export type ActivityRoute = {
  sessionId: string;
  requestId: string;
  activityId: string;
  profileGeneration: number;
};

export interface ActivityRouteRegistry {
  set(route: ActivityRoute): void;
  get(activityId: string): ActivityRoute | undefined;
  delete(activityId: string): void;
}

export function makeActivityRouteRegistry(): ActivityRouteRegistry {
  const routes = new Map<string, ActivityRoute>();
  return {
    set: (route) => { routes.set(route.activityId, route); },
    get: (activityId) => routes.get(activityId),
    delete: (activityId) => { routes.delete(activityId); },
  };
}

export function makeActivitySpeechEgress(
  wire: ActivityWireEgress,
  routes: ActivityRouteRegistry = makeActivityRouteRegistry(),
): RadioDjSpeechPort & ExhibitionSpeechPort {
  return {
    open(input): void {
      routes.set({
        sessionId: input.sessionId,
        activityId: input.activityId,
        requestId: input.requestId,
        profileGeneration: input.profileGeneration,
      });
    },
    async speak(input): Promise<"completed"> {
      const route = routes.get(input.activityId);
      if (!route) return "completed";
      wire.emit(
        route.sessionId,
        route.requestId,
        route.activityId,
        route.profileGeneration,
        { kind: "text", text: input.text },
      );
      return "completed";
    },
    interrupt(_activityId): void {
      // 실제 오디오는 shell이 입력 감지 즉시 interruptTts한다. wire에는 stale ID를 통해 늦은 출력을 폐기한다.
    },
    close(activityId, reason): void {
      const route = routes.get(activityId);
      if (!route) return;
      wire.emit(
        route.sessionId,
        route.requestId,
        route.activityId,
        route.profileGeneration,
        reason === "finished"
          ? { kind: "finish" }
          : { kind: "error", message: "cancelled" },
      );
      routes.delete(activityId);
    },
  };
}
